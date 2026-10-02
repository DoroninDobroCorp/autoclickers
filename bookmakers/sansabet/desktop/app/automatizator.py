import asyncio
import websockets
import json
import time
import pyautogui
from convert import convert
from collections import deque
from dataclasses import dataclass, field
from typing import Optional, Dict, Deque


@dataclass
class Bet:
    match: dict
    outcome: dict
    added_at: float = field(default_factory=time.time)
    last_updated: float = field(default_factory=time.time)
    check_count: int = 0


class Automatizator:
    # Переменная для хранения кэша
    outcomes_cache: Dict[tuple, Bet] = {}

    def __init__(self, put_bet, telegram_logger=None) -> None:
        self.put_bet = put_bet
        self.active_bet: Optional[Bet] = None
        self.telegram_log = telegram_logger
        self.basket: Deque[Bet] = deque(maxlen=5)
        self.outcomes_cache: Dict[tuple, Bet] = {}
        self.config = {
            "min_roi": 3,
            "target_roi": 3,
            "basket_timeout": 120,
            "min_time": 1,
            "max_time": 10,
            "required_signals": 3,
            "bet_size": 1,
            "bookmaker": "Sansabet",
            "sports": ["Soccer", "Tennis"],
        }
        self.analyzer_ws_url = "ws://188.253.24.91:7300/output"
        self._stop_event = asyncio.Event()

    async def reset_ui(self):
        """Сброс UI в исходное состояние"""
        CLOSE_BET = (1309, 590)  # Координаты крестика
        CENTER_SCREEN = (734, 436)  # Центр экрана

        try:
            pyautogui.click(CLOSE_BET[0], CLOSE_BET[1])
            await asyncio.sleep(0.5)
            pyautogui.moveTo(CENTER_SCREEN[0], CENTER_SCREEN[1])
            await asyncio.sleep(0.5)
        except Exception as e:
            print(f"UI reset error: {e}")

    async def monitor_active_bet(self):
        """Непрерывный мониторинг активной ставки"""
        while not self._stop_event.is_set():
            if self.active_bet:
                # Проверяем, не устарела ли ставка
                if time.time() - self.active_bet.added_at > self.config["max_time"]:
                    await self.cancel_bet()
                    self.active_bet = None
                    continue

                # Проверяем ROI в кеше
                key = (self.active_bet.match["second"]["matchId"],
                       self.active_bet.outcome["outcome"])
                cached = self.outcomes_cache.get(key)

                if cached and cached.outcome.get("roi", 0) < 0:
                    await self.cancel_bet()
                    self.active_bet = None
                    self.telegram_log("Отмена: ROI упал ниже 0%")

            await asyncio.sleep(1)

    async def check_basket(self):
        """Проверка ставок в корзине"""
        while not self._stop_event.is_set():
            current_time = time.time()

            # Очистка устаревших ставок
            self.basket = deque(
                [bet for bet in self.basket if current_time - bet.added_at <= self.config["basket_timeout"]],
                maxlen=5
            )

            if not self.active_bet and self.basket:
                for bet in list(self.basket):
                    key = (bet.match["second"]["matchId"], bet.outcome["outcome"])
                    cached = self.outcomes_cache.get(key)

                    if not cached:
                        continue

                    # Первая проверка ROI
                    first_check_roi = cached.outcome.get('roi', 0)
                    if first_check_roi >= self.config["target_roi"]:
                        # Ждем возможного обновления
                        await asyncio.sleep(1)

                        # Вторая проверка с актуальными данными
                        cached = self.outcomes_cache.get(key)
                        second_check_roi = cached.outcome.get('roi', 0) if cached else 0

                        if second_check_roi >= self.config["target_roi"]:
                            # Дополнительная проверка коэффициента
                            expected_coef = str(bet.outcome['score2']['value'])
                            current_coef = str(cached.outcome['score2']['value'])

                            if expected_coef == current_coef:
                                success = await self.place_bet(cached)
                                if success:
                                    self.basket.remove(bet)
                                    print(f"Ставка из корзины: ROI {second_check_roi}%")
                                    self.telegram_log(f"Ставка из корзины: ROI {second_check_roi}%")

            await asyncio.sleep(2)

    async def place_bet(self, bet: Bet):
        """Размещение ставки"""
        self.active_bet = bet

        match = bet.match
        outcome = bet.outcome
        sansa_outcome = convert(
            outcome['outcome'],
            match['sportName'],
            outcome['score2']['raw']
        )

        putbet_request = (
            f"{match['second']['Raw']['match_name']}, "
            f"{sansa_outcome}, "
            f"{outcome['score2']['value']}, "
            f"{self.config['bet_size']}"
        )

        result = await self.put_bet(0, putbet_request, {
            "match": match,
            "outcome": outcome
        })

        if not result:
            await self.reset_ui()
            self.active_bet = None

    async def move_to_basket(self):
        """Перемещение ставки в корзину"""
        if self.active_bet:
            # Проверяем, нет ли уже такой ставки в корзине
            match_id = self.active_bet.match["second"]["matchId"]
            outcome = self.active_bet.outcome["outcome"]

            if not any(
                b.match["second"]["matchId"] == match_id and
                b.outcome["outcome"] == outcome
                for b in self.basket
            ):
                self.basket.append(self.active_bet)
                print(f"Bet in basket: {len(self.basket)}")
                self.telegram_log(f'Ставка в корзине. В корзине сейчас: {len(self.basket)}')

            await self.reset_ui()
            self.active_bet = None

    async def cancel_bet(self):
        """Отмена текущей ставки"""
        if self.active_bet:
            await self.reset_ui()
            self.active_bet = None

    async def process_analyzer_message(self, message: str) -> None:
        """
        Обработка сообщений от анализатора с:
        - Полной поддержкой ROI 0-3%
        - Подсчетом последовательных сигналов
        - Приоритезацией новых ставок при ROI ≥3%
        - Корректной работой с корзиной
        """
        try:
            data = json.loads(message)
            if not data:
                return

            current_time = time.time()
            sports_filter = self.config["sports"]

            for match in data:
                # Проверка структуры данных
                if not all(key in match for key in ['second', 'outcome', 'sportName']):
                    continue

                if match['sportName'] not in sports_filter:
                    continue

                second = match["second"]
                if 'matchId' not in second or 'Raw' not in second:
                    continue

                for outcome in match["outcome"]:
                    if not all(key in outcome for key in ['outcome', 'roi', 'score2']):
                        continue

                    try:
                        current_roi = float(outcome.get("roi", 0))
                    except (TypeError, ValueError):
                        continue

                    key = (second["matchId"], outcome["outcome"])

                    # Обновление кеша
                    if key in self.outcomes_cache:
                        cached_bet = self.outcomes_cache[key]
                        if current_time - cached_bet.last_updated > self.config["max_time"]:
                            del self.outcomes_cache[key]
                            continue

                        cached_bet.outcome = outcome
                        cached_bet.last_updated = current_time
                        cached_bet.check_count += 1
                    else:
                        self.outcomes_cache[key] = Bet(
                            match=match,
                            outcome=outcome,
                            added_at=current_time,
                            last_updated=current_time,
                            check_count=1
                        )

                    # Обработка активной ставки
                    if self.active_bet and self.active_bet.match["second"]["matchId"] == second["matchId"]:
                        if current_roi < 0:  # ROI упал ниже 0 - отменяем
                            await self.cancel_bet()
                            self.telegram_log(f"Отмена: ROI упал до {current_roi:.2f}%")
                        continue

                    # Обработка новых ставок
                    if current_roi >= self.config["target_roi"]:
                        if not self.active_bet:
                            await self.place_bet(self.outcomes_cache[key])
                    elif self.config["min_roi"] <= current_roi < self.config["target_roi"]:
                        if not any(b.match["second"]["matchId"] == second["matchId"] and 
                                   b.outcome["outcome"] == outcome["outcome"] 
                                   for b in self.basket):
                            self.basket.append(self.outcomes_cache[key])

        except Exception as e:
            self.telegram_log(f"Ошибка обработки сообщения: {str(e)}")

    async def clean_cache(self):
        """Очистка кеша от старых записей"""
        while not self._stop_event.is_set():
            current_time = time.time()
            to_remove = [
                key for key, bet in self.outcomes_cache.items()
                if current_time - bet.last_updated > self.config["max_time"]
            ]

            for key in to_remove:
                self.outcomes_cache.pop(key)

            await asyncio.sleep(30)

    async def connect_to_analyzer(self):
        """Подключение к анализатору"""
        print("Connect to WebSocket...")
        while not self._stop_event.is_set():
            try:
                async with websockets.connect(self.analyzer_ws_url) as websocket:
                    print("GOOD connect to WebSocket")
                    await websocket.send(json.dumps({
                        "bookmakers": [{
                            "name": self.config["bookmaker"],
                            "live": {
                                "filter": True,
                                "sports": self.config["sports"]
                            },
                            "prematch": {
                                "filter": False,
                                "sports": []
                            }
                        }]
                    }))

                    while not self._stop_event.is_set():
                        message = await websocket.recv()
                        await self.process_analyzer_message(message)

            except Exception as e:
                print(f"ERROR WebSocket: {e}. Try again after 5 sec...")
                await asyncio.sleep(5)

    async def run(self):
        """Основной цикл работы"""
        try:
            # Запускаем фоновые задачи
            tasks = [
                asyncio.create_task(self.monitor_active_bet()),
                asyncio.create_task(self.check_basket()),
                asyncio.create_task(self.clean_cache()),
                asyncio.create_task(self.connect_to_analyzer())
            ]

            await asyncio.gather(*tasks)

        except asyncio.CancelledError:
            self._stop_event.set()
            print("CLOSE Automatizator...")

        except Exception as e:
            print(f"ERROR in run(): {e}")
            self._stop_event.set()
