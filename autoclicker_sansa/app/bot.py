import functools
import math
import time
import threading
import asyncio
import requests
import pyautogui
import json
import os
import re
import random
from PIL import ImageChops, ImageStat, Image
from automatizator import Automatizator
from convert import convert

# Добавляем необходимые импорты для Google Cloud Vision API
import io
import logging
from google.cloud import vision

global chosen_candidated

# Глобальный словарь для хранения всех последних ставок
successful_bets = {}
BET_EXPIRATION_TIME = 3600

# Настройка переменных окружения и логирования для Google Cloud Vision API
credentials_path = os.path.join(os.path.dirname(__file__),
                                'vovkaproject-1c326021c3bf.json')
os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = credentials_path

logging.basicConfig(level=logging.DEBUG, format='[%(levelname)s] %(message)s')

# ---------------------- Настройки Telegram-бота ----------------------
TELEGRAM_BOT_TOKEN = "7626905788:AAGSqKS9LJG5q_nm6ljiCd75prWmpeQQ_PQ"
BASE_URL = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}"
SUBSCRIBERS_FILE = "subscribers.txt"
subscribers = set()

# Флаг для тестирования скриншотов (отправка в Telegram)
DEBUG_SCREENSHOT = False

# Инициализируем клиента Google Cloud Vision
vision_client = vision.ImageAnnotatorClient()

# Функции для логирования сделаной ставки
HEADERS = {
    "Content-Type": "application/json"
}


# Конфигурация проверок ROI
ROI_CONFIG = {
    'min_roi': 3,      # Минимальный ROI для принятия ставки
    'cancel_roi': 0,    # ROI, при котором ставка отменяется
    'target_roi': 3
}


# Декоратор для защиты от дублирования
def prevent_duplicate_processing(func):

    @functools.wraps(func)
    async def wrapper(*args, **kwargs):
        raw = kwargs.get('raw') or (args[2] if len(args) > 2 else None)
        current_key = None

        if raw:
            match_data = raw.get('match', {})
            outcome_data = raw.get('outcome', {})
            current_key = (
                match_data.get('second', {}).get('matchId'),
                outcome_data.get('outcome'),
                outcome_data.get('roi')
            )

        # Проверяем только для успешных ставок
        if current_key and current_key in successful_bets:
            last_time = successful_bets[current_key]
            if time.time() - last_time < BET_EXPIRATION_TIME:
                telegram_log(f"Пропуск дублирующей успешной ставки (ID: {current_key[0]})")
                return False

        # Выполняем функцию
        result = await func(*args, **kwargs)

        # Если ставка успешна и есть ключ - добавляем в словарь
        if result and current_key:
            successful_bets[current_key] = time.time()
            telegram_log(f"Добавлена успешная ставка в кэш (ID: {current_key[0]})")

        return result

    return wrapper


OUTCOME_SEARCH_REGION = (220, 273, 938, 691)


def calc_bet(raw):
    url = "http://188.253.24.91:7010/calc-bet"

    pair = raw['match']
    pair['outcome'] = raw['outcome']
    payload = {
        "userId": "0",
        "pair": pair
    }

    response = requests.post(url, data=json.dumps(payload), headers=HEADERS)
    if response.status_code != 200:
        print(f"[ERROR] Не удалось рассчитать ставку: {response.text}")
        return

    print("[INFO] Ставка рассчитана:", response.json()['calcBet'])
    return response.json()['calcBet']


def log_bet_accept(raw, calculatedBet, sum, coef, time):
	url = "http://188.253.24.91:7010/log-bet-accept"

	pair = raw['match']
	pair['outcome'] = raw['outcome']
	payload = {
		"pair": pair,
		"bet": calculatedBet,
		"sum": sum,
		"coef": coef,
		"time": time
	}

	response = requests.post(url, data=json.dumps(payload), headers=HEADERS)
	if response.status_code != 200:
		print(f"[ERROR] Не удалось логировать ставку: {response.text}")
		return

	print("[INFO] Ставка логирована!")


def extract_text_google_vision(pil_image):
	"""
	Отправляет изображение в Google Cloud Vision API и получает:
	  - полный распознанный текст (full_text),
	  - список блоков (results) с их bounding box, текстом и confidence.
	"""
	if pil_image.mode != "RGB":
		pil_image = pil_image.convert("RGB")
	buf = io.BytesIO()
	pil_image.save(buf, format="JPEG")
	image_content = buf.getvalue()
	image = vision.Image(content=image_content)
	response = vision_client.text_detection(image=image)
	texts = response.text_annotations
	if not texts:
		logging.warning("Текст не обнаружен!")
		return "", []
	full_text = texts[0].description
	results = []
	for annotation in texts[1:]:
		vertices = [(vertex.x, vertex.y) for vertex in annotation.bounding_poly.vertices]
		confidence = getattr(annotation, 'score', None)
		results.append([vertices, annotation.description, confidence])
	return full_text, results


def load_subscribers():
	global subscribers
	if os.path.exists(SUBSCRIBERS_FILE):
		with open(SUBSCRIBERS_FILE, "r") as f:
			for line in f:
				line = line.strip()
				if line:
					subscribers.add(line)
		print(f"[INFO] Загружено подписчиков: {subscribers}")


def save_subscribers():
	with open(SUBSCRIBERS_FILE, "w") as f:
		for sub in subscribers:
			f.write(f"{sub}\n")


def send_message(chat_id, message):
    """отправка сообщения"""
    url = f"{BASE_URL}/sendMessage"
    payload = {"chat_id": chat_id, "text": message}
    try:
        response = requests.post(url, json=payload, timeout=10)
        if response.status_code != 200:
            print(f"[ERROR] Ошибка отправки сообщения: {response.text}")
            return False
        return True
    except Exception as e:
        print(f"[ERROR] Ошибка при отправке сообщения: {str(e)}")
        return False

def send_photo(chat_id, photo_path, caption=""):
    """отправка фото"""
    url = f"{BASE_URL}/sendPhoto"
    try:
        with open(photo_path, "rb") as photo_file:
            files = {"photo": photo_file}
            data = {"chat_id": chat_id, "caption": caption}
            response = requests.post(url, data=data, files=files, timeout=10)
            if response.status_code != 200:
                print(f"[ERROR] Ошибка отправки фото: {response.text}")
    except Exception as e:
        print(f"[ERROR] Ошибка при отправке фото: {str(e)}")


def telegram_log(message):
	"""
    Отправляет сообщение всем подписчикам
    (используем для логов по распознаванию и т.п.)
    """
	for chat_id in subscribers:
		send_message(chat_id, message)


@prevent_duplicate_processing
async def put_bet(chat_id, text, raw=None):
    """
    Обработка ставки с:
    - Непрерывным мониторингом ROI во время выполнения
    - Отменой при падении ROI ниже 0%
    - Таймаутом 6 секунд при отсутствии обновлений
    - Корректным восстановлением состояния после отмены
    - Поддержкой ставок как из Telegram, так и от анализатора
    """
    try:
        # Инициализация мониторинга для автоматических ставок
        monitor_task = None
        if raw:
            monitor_task = asyncio.create_task(
                monitor_active_bet_while_processing(raw)
            )

        # ===== Обработка ставки через сообщение из Telegram =====
        if text and not raw:
            telegram_log(f"Получена ставка из Telegram: {text}")

            parts = [p.strip() for p in text.split(",")]
            if len(parts) != 4:
                await send_message(chat_id, "Формат: Матч, Исход, Кэф, Сумма")
                return False

            match_name, outcome, coef_condition, bet_amount_str = parts

            try:
                bet_amount = float(bet_amount_str.replace(",", "."))
                if bet_amount < 1:
                    await send_message(chat_id, "Минимальная ставка - 1")
                    return False
            except ValueError:
                await send_message(chat_id, "Неверная сумма ставки")
                return False

            # 1. Поиск матча
            find_match(match_name)
            await human_like_delay(3, 3.5)

            # 2. Поиск и клик по исходу
            coords, matched_text = await optimized_search_for_outcome_async(
                outcome.strip(),
                OUTCOME_SEARCH_REGION
            )
            if not coords:
                await send_message(chat_id, "Исход не найден")
                return False

            human_like_move_to(coords[0], coords[1])
            await human_like_delay(0.3, 0.7)
            pyautogui.click()

            await human_like_delay(1.5, 2)

            # 3. Ввод суммы
            bet_coords = find_bet_input_coords()
            if not bet_coords:
                await send_message(chat_id, "Ошибка ввода суммы")
                return False

            human_like_move_to(bet_coords[0], bet_coords[1])
            await human_like_delay(0.2, 0.5)
            pyautogui.click(clicks=2)

            # Человекообразный ввод суммы
            for char in str(bet_amount):
                pyautogui.write(char, interval=random.uniform(0.1, 0.3))
                await human_like_delay(0.05, 0.15)

            await human_like_delay(1, 1.5)

            # 4. Проверка коэффициента
            coef = await verify_coefficient(bet_coords, coef_condition)
            if not coef:
                await send_message(chat_id, "Коэффициент не соответствует")
                await click_retry()
                return False

            # 5. Подтверждение ставки
            pyautogui.press("enter")
            if await wait_for_bet_confirmation():
                await send_message(chat_id, f"Ставка {bet_amount} принята!")
                return True

            return False

        # ===== Обработка автоматической ставки через анализатор =====
        elif raw:
            telegram_log(f"Обработка ставки (ROI: {raw['outcome'].get('roi', 0)}%)")

            # Подготовка данных
            match_data = raw['match']
            outcome_data = raw['outcome']

            # Конвертация исхода для сансабета
            sansa_outcome = convert(
                outcome_data['outcome'],
                match_data['sportName'],
                outcome_data['score2']['raw']
            )

            # Формирование параметров ставки
            bet_params = (
                match_data['second']['Raw']['match_name'],
                sansa_outcome,
                str(outcome_data['score2']['value']),
                str(ROI_CONFIG.get('bet_size', 1)),
                raw
            )

            result = await execute_bet_steps(*bet_params)

            # Логирование результата
            if result:
                log_bet_accept(raw, calc_bet(raw), ROI_CONFIG.get('bet_size', 1), 
                               outcome_data['score2']['value'], time.time())
            return result

        else:
            telegram_log("Неверные параметры put_bet")
            return False

    except Exception as e:
        error_msg = f"‼ Ошибка put_bet: {str(e)}"
        telegram_log(error_msg)
        if chat_id:
            await send_message(chat_id, "Внутренняя ошибка бота")
        return False
    finally:
        # Гарантированная отмена мониторинга
        if monitor_task and not monitor_task.done():
            monitor_task.cancel()


async def should_cancel_bet(raw: dict) -> bool:
    """
    Определяет, нужно ли отменить текущую ставку на основе:
    - Текущего ROI
    - Времени выполнения ставки
    - Количества последовательных сигналов

    Возвращает True если ставку нужно отменить, False если можно продолжать
    """
    if not raw or 'outcome' not in raw:
        return False

    try:
        # Проверяем актуальные данные из кеша
        match_id = raw['match']['second']['matchId']
        outcome_type = raw['outcome']['outcome']
        key = (match_id, outcome_type)

        cached = Automatizator.outcomes_cache.get(key)
        if cached:
            current_roi = cached.outcome.get('roi', 0)

            # 1. Немедленная отмена при ROI ниже минимального
            if current_roi < ROI_CONFIG['min_roi']:
                telegram_log(f"Требуется отмена: ROI {current_roi}% < {ROI_CONFIG['min_roi']}%")
                return True

        # 2. Проверка времени выполнения
        if hasattr(raw, 'start_time'):
            elapsed = time.time() - raw.start_time
            if elapsed > 30:
                telegram_log(f"Превышено время выполнения ({elapsed:.1f} сек)")
                return True

        # 3. Проверка количества сигналов для ROI 0-3%
        current_roi = raw['outcome'].get('roi', 0)
        if 0 <= current_roi < 3:
            if not hasattr(raw, 'consecutive_signals'):
                raw.consecutive_signals = 1
            else:
                raw.consecutive_signals += 1

            if raw.consecutive_signals < 3:
                telegram_log(f"ROI 0-3%: ждём {3 - raw.consecutive_signals} сигналов")
                return True

        return False

    except Exception as e:
        telegram_log(f"Ошибка проверки отмены: {str(e)}")
        return False


async def monitor_active_bet_while_processing(raw: dict):
    """
    Мониторинг изменений ROI во время выполнения ставки
    Прерывает процесс если:
    - ROI упал ниже минимального
    - Нет обновлений более 6 секунд
    """
    if not raw:
        return

    match_id = raw['match']['second']['matchId']
    outcome_type = raw['outcome']['outcome']
    last_update_time = time.time()

    try:
        while True:
            await asyncio.sleep(1)  # Проверка каждую секунду

            # Проверка таймаута (6 секунд без обновлений)
            if time.time() - last_update_time > 6:
                telegram_log("Таймаут: нет обновлений 6 секунд")
                await cancel_current_bet()
                return

            # Получаем актуальные данные из кеша
            key = (match_id, outcome_type)
            cached = Automatizator.outcomes_cache.get(key)
            if not cached:
                continue

            last_update_time = time.time()
            current_roi = cached.outcome.get('roi', 0)

            # ROI упал ниже 0 - отмена
            if current_roi < 0:
                await cancel_current_bet()
                telegram_log(f"Отмена: ROI упал до {current_roi}%")
                return

    except Exception as e:
        telegram_log(f"Ошибка мониторинга: {str(e)}")


async def execute_bet_steps(match_name: str, outcome: str, 
                            coef_condition: str, bet_amount: float,
                            raw: dict = None) -> bool:
    """
    Улучшенный цикл выполнения ставки:
    - Контроль времени выполнения
    - Проверка ROI на каждом этапе
    - Человекообразные действия
    - Защита от зависаний
    """
    # Инициализация мониторинга
    try:
        match_id = raw['match']['second']['matchId'] if raw else None
        outcome_type = raw['outcome']['outcome'] if raw else None

        # Запускаем мониторинг ROI в фоне
        monitor_task = asyncio.create_task(
            monitor_active_bet_while_processing(raw)
        )

        # 1. Поиск матча
        find_match(match_name)
        await human_like_delay(1.5, 2.0)

        # 2. Проверка актуальности и поиск исхода
        if monitor_task.done():
            return False

        coords, _ = await optimized_search_for_outcome_async(outcome, OUTCOME_SEARCH_REGION)
        if not coords:
            monitor_task.cancel()
            return False

        # 3. Выбор исхода с проверкой
        human_like_move_to(*coords)
        await human_like_delay(0.3, 0.7)
        pyautogui.click()

        if monitor_task.done():
            return False

        # 4. Ввод суммы
        bet_coords = find_bet_input_coords()
        if not bet_coords:
            await click_retry()
            monitor_task.cancel()
            return False

        human_like_move_to(*bet_coords)
        await human_like_delay(0.2, 0.5)
        pyautogui.click(clicks=2)

        # Человекообразный ввод
        for char in str(bet_amount):
            if monitor_task.done():
                return False
            pyautogui.write(char, interval=random.uniform(0.1, 0.3))
            await human_like_delay(0.05, 0.15)

        # 5. Двойная проверка коэффициента
        for attempt in range(2):
            coef = await verify_coefficient(bet_coords, coef_condition)
            if not coef:
                if attempt == 0:
                    await human_like_delay(1.0, 2.0)
                    continue
                await click_retry()
                monitor_task.cancel()
                return False

            if monitor_task.done():
                return False
            break

        # 6. Подтверждение ставки
        pyautogui.press("enter")
        if await wait_for_bet_confirmation():
            telegram_log(f"Успешная ставка: {bet_amount} на {coef}")
            monitor_task.cancel()
            return True

        return False

    except Exception as e:
        telegram_log(f"Ошибка выполнения ставки: {str(e)}")
        return False
    finally:
        if not monitor_task.cancelled():
            monitor_task.cancel()
        await clean_interface()


async def cancel_current_bet():
    """Отмена ставки с возвратом в исходное состояние"""
    try:
        # Клик по крестику
        pyautogui.click(1309, 590)
        await asyncio.sleep(0.5)

        # Возврат в центр экрана
        screen_width, screen_height = pyautogui.size()
        pyautogui.moveTo(screen_width // 2, screen_height // 2)

        telegram_log("Ставка отменена")
    except Exception as e:
        telegram_log(f"Ошибка при отмене ставки: {str(e)}")


async def human_like_delay(min_delay=0.1, max_delay=0.5):
    """Случайная задержка между действиями с небольшим шансом на длительную паузу"""
    if random.random() < 0.05:  # 5% chance for longer delay
        await asyncio.sleep(random.uniform(1.0, 2.5))
    else:
        await asyncio.sleep(random.uniform(min_delay, max_delay))


def human_like_move_to(x, y):
    """Улучшенное перемещение с более естественной траекторией"""
    current_x, current_y = pyautogui.position()
    distance = ((x - current_x)**2 + (y - current_y)**2)**0.5

    # Чем больше расстояние, тем больше шагов и отклонений
    steps = max(10, min(30, int(distance / 10)))
    deviation = max(5, min(20, int(distance / 20)))

    for i in range(steps):
        t = i / steps
        # Добавляем нелинейность и случайные отклонения
        ease = 0.5 - 0.5 * math.cos(t * math.pi)  # Ease-in-out
        dev_x = random.randint(-deviation, deviation) * (1 - t)
        dev_y = random.randint(-deviation, deviation) * (1 - t)

        move_x = current_x + (x - current_x) * ease + dev_x
        move_y = current_y + (y - current_y) * ease + dev_y

        pyautogui.moveTo(move_x, move_y, duration=0.01)
        time.sleep(random.uniform(0.01, 0.05))

    pyautogui.moveTo(x, y, duration=0.1)


async def poll_updates():
    """Обработчик сообщений"""
    offset = None
    last_update_time = time.time()

    while True:
        try:
            # Получение обновлений с таймаутом
            params = {'timeout': 10, 'offset': offset}
            response = requests.get(f"{BASE_URL}/getUpdates",
                                    params=params, timeout=15)
            
            if response.status_code != 200:
                print(f"[ERROR] Ошибка получения обновлений: {response.text}")
                await asyncio.sleep(5)
                continue

            data = response.json()
            
            # Обработка сообщений
            for update in data.get("result", []):
                offset = update["update_id"] + 1
                message = update.get("message", {})
                if not message:
                    continue

                chat_id = str(message["chat"]["id"])
                text = message.get("text", "").strip()

                # Обработка команды /start
                if text.lower() == "/start":
                    if chat_id not in subscribers:
                        subscribers.add(chat_id)
                        save_subscribers()
                        send_message(chat_id, "Вы подписаны на логи бота!")
                        print(f"[INFO] Новый подписчик: {chat_id}")
                
                # Обработка других сообщений
                else:
                    await put_bet(chat_id, text)

            # Сброс offset при долгом бездействии
            if time.time() - last_update_time > 60:
                offset = None
                last_update_time = time.time()

            await asyncio.sleep(1)

        except requests.RequestException as e:
            print(f"[ERROR] Ошибка соединения: {str(e)}")
            await asyncio.sleep(5)
        except Exception as e:
            print(f"[CRITICAL] Ошибка в poll_updates: {str(e)}")
            await asyncio.sleep(1)


def open_browser_and_navigate():
    """
    Открываем sansabet.com (или другой нужный сайт) через адресную строку.
    """
    pyautogui.hotkey('ctrl', 'l')
    time.sleep(2)
    pyautogui.write("https://sansabet.com", interval=0.1)
    pyautogui.press("enter")


def wait_for_site_ready_color(target_color, color_tolerance=10,
                              check_region=(604, 119, 5, 5)):
	"""
	Ждёт, пока в зоне check_region (5x5 пикселей) цвет не станет близким к
      target_color (± color_tolerance).
	Если цвет не совпадает, ждёт 10 секунд и пробует снова.
	"""
	while True:
		screenshot_candidate = pyautogui.screenshot(region=check_region)
		stat = ImageStat.Stat(screenshot_candidate)
		avg_color = tuple(int(c) for c in stat.mean)
		telegram_log(f"[DEBUG] Checking site color at {check_region}: {avg_color}")
		
		# Проверяем, что средний цвет близок к ожидаемому
		if all(abs(avg_color[i] - target_color[i]) <= color_tolerance for i in range(3)):
			telegram_log("[INFO] Site color matched, proceeding to login.")
			break
		else:
			telegram_log("[INFO] Site color not matched, waiting 10 seconds before retry.")
			time.sleep(10)


def check_for_text(expected_text, top_left, bottom_right, timeout=15):
	"""
	Ожидает появления строки expected_text в области (top_left => bottom_right) не дольше timeout секунд.
	Для распознавания текста используется Google Cloud Vision.
	"""
	x1, y1 = top_left
	x2, y2 = bottom_right
	region = (x1, y1, x2 - x1, y2 - y1)
	start = time.time()
	screenshot_sent = False
	while time.time() - start < timeout:
		screenshot = pyautogui.screenshot(region=region)
		time.sleep(1)
		if DEBUG_SCREENSHOT and not screenshot_sent:
			debug_path = "debug_screenshot.png"
			screenshot.save(debug_path)
			for chat_id in subscribers:
				send_photo(chat_id, debug_path, caption="Тестовый скриншот")
			screenshot_sent = True
		full_text, _ = extract_text_google_vision(screenshot)
		print(f"[DEBUG] OCR-текст в зоне {region}: {full_text}")
		if expected_text.lower() in full_text.lower():
			if DEBUG_SCREENSHOT:
				telegram_log("Распознанный текст: " + full_text)
			return True
		time.sleep(1)
	return False


def do_login():
	"""
	Примерный сценарий логина (на реальном проекте заменить координаты/логику).
	"""
	print("[INFO] Выполняется логин...")
	pyautogui.click(784, 133, clicks=2)
	pyautogui.write("Ght", interval=0.1)
	time.sleep(1)
	pyautogui.click(967, 132, clicks=2)
	pyautogui.write("Doronin7", interval=0.1)
	time.sleep(1)
	pyautogui.click(1159, 130, clicks=1)
	time.sleep(3)

	# Закрываем всплывающее окно
	pyautogui.click(551, 338, clicks=1)
	time.sleep(2)


def find_match(match_name):
	"""
	Переходит в лайв и вводит название матча match_name в поиске.
	"""
	live_coords = (641, 190)
	match_input_coords = (1065, 240)
	match_click_coords = (804, 385)

	pyautogui.click(live_coords[0], live_coords[1])
	time.sleep(3.5)
	
	pyautogui.click(match_input_coords[0], match_input_coords[1])
	time.sleep(1)
	pyautogui.write(match_name, interval=0.05)
	time.sleep(3)
	pyautogui.click(match_click_coords[0], match_click_coords[1])
	time.sleep(2)


def optimized_search_for_outcome(outcome, outcome_search_region, max_scroll_iterations=10, difference_threshold=30):
	"""
	Новая версия функции поиска исхода, которая объединяет OCR-блоки только если
	следующий блок начинаетcя сразу с нужного символа (без добавления пробела).

	Возвращает (x, y) координаты левого верхнего угла найденного текста (coords)
	и саму строку (matched_text), которая полностью совпала с outcome.
	Или None, None, если исход не найден.
	"""
	previous_screenshot = None
	x1, y1, x2, y2 = outcome_search_region
	region_width = x2 - x1
	region_height = y2 - y1
	expected = outcome.lower().strip()

	def get_combined_top_left(results_list, start_idx, length):
		xs = []
		ys = []
		for offset in range(length):
			block_vertices = results_list[start_idx + offset][0]
			for (vx, vy) in block_vertices:
				xs.append(vx)
				ys.append(vy)
		return (x1 + min(xs), y1 + min(ys))

	for iteration in range(max_scroll_iterations):
		current_screenshot = pyautogui.screenshot(region=(x1, y1, region_width, region_height))
		time.sleep(1)

		# Отправка отладочного скриншота
		if DEBUG_SCREENSHOT:
			debug_outcome_path = f"debug_outcome_screenshot_{iteration+1}.png"
			current_screenshot.save(debug_outcome_path)
			for chat_id in subscribers:
				send_photo(chat_id, debug_outcome_path, caption=f"Тестовый скриншот, итерация {iteration+1}")

		# Проверяем, нет ли изменений в области (чтобы понять, дошли ли до низа)
		if previous_screenshot is not None:
			diff = ImageChops.difference(previous_screenshot, current_screenshot)
			stat = ImageStat.Stat(diff)
			mean_diff = sum(stat.mean) / len(stat.mean)
			if mean_diff < difference_threshold:
				telegram_log("[INFO] Существенных изменений в области не обнаружено, возможно, достигнут низ страницы.")
				break

		# Распознаём текст на текущем скриншоте
		full_text, results = extract_text_google_vision(current_screenshot)

		n = len(results)
		# Перебираем OCR-блоки для поиска последовательного совпадения с ожидаемым исходом
		for i in range(n):
			candidate = results[i][1].strip().lower()
			if not expected.startswith(candidate):
				continue

			current_combined = candidate
			# Если текущий блок полностью совпадает с ожидаемым, возвращаем координаты
			if current_combined == expected:
				coords = get_combined_top_left(results, i, 1)
				matched_text = results[i][1].strip()
				telegram_log(f"[DEBUG] Найден исход в одном блоке: '{current_combined}'. Координаты: {coords}")
				return coords, matched_text

			# Пробуем объединить с последующими блоками (до 3-х дополнительных)
			for j in range(i + 1, min(i + 4, n)):
				next_block = results[j][1].strip().lower()
				potential = current_combined + " " + next_block
				if expected.startswith(potential):
					current_combined = potential
					if current_combined == expected:
						coords = get_combined_top_left(results, i, j - i + 1)
						# Склеиваем исходные фрагменты для возвращаемого matched_text
						original_text_fragments = [
							results[k][1].strip() for k in range(i, j + 1)
						]
						matched_text = " ".join(original_text_fragments)
						telegram_log(f"[DEBUG] Найден исход путём объединения блоков {i}-{j}: '{current_combined}'. Координаты: {coords}")
						return coords, matched_text
				else:
					#telegram_log(f"[DEBUG] Объединение '{current_combined + ' ' + next_block}' не соответствует '{expected}'. Прерываем объединение.")
					break

		previous_screenshot = current_screenshot
		time.sleep(1)

	telegram_log("[ERROR] Не удалось найти исход после прокрутки.")
	return None, None

# ======================= Координаты и константы для ставок =======================

# Две группы координат для ввода ставки
BET_INPUT_CANDIDATES_SET1 = [(1202, 445), (1200, 491), (1200, 660)]  # пример
BET_INPUT_CANDIDATES_SET2 = [(1201, 657)]  # пример

# Цвет, который мы ожидаем увидеть на месте ввода суммы
TARGET_COLOR = (218, 218, 218)
COLOR_TOLERANCE = 4

# Параметры для области скрина коэффициента (финальная проверка)
COEFFICIENT_SCREENSHOT_SHIFT_Y = 150
COEFFICIENT_SCREENSHOT_PADDING_X = 250
COEFFICIENT_SCREENSHOT_PADDING_BOTTOM = 80

# Доп. регион для первичной проверки (теперь НЕ используем скриншоты)
FIRST_CLICK_COEF_REGION = (1000, 400, 300, 100)  # остаётся для примера, но не применяем


def check_coefficient_condition(found_coef, condition_str):
	"""
	Проверяет, удовлетворяет ли найденный коэффициент (found_coef) условиям,
	заданным в строке condition_str. Пример условия: ">1.1", "<3", ">1.1 <4" или просто "1.5".
	"""
	tokens = condition_str.split()
	valid = True
	for token in tokens:
		token = token.strip()
		if token.startswith(">"):
			try:
				threshold = float(token[1:])
				if not (found_coef >= threshold):
					valid = False
			except:
				valid = False
		elif token.startswith("<"):
			try:
				threshold = float(token[1:])
				if not (found_coef <= threshold):
					valid = False
			except:
				valid = False
		else:
			try:
				exact_value = float(token)
				if not (found_coef == exact_value):
					valid = False
			except:
				valid = False
	return valid

def extract_coefficient_from_region(region, chosen_candidate=None):
	"""
	Делаем скриншот заданной области, обрезаем её и через OCR вытаскиваем число.
	Используется для финальной проверки (после ввода суммы).
	"""
	screenshot = pyautogui.screenshot(region=region)
	# Обрезаем правую половину и нижние 2/3
	if chosen_candidate in BET_INPUT_CANDIDATES_SET1:
		width, height = screenshot.size
		left = int(width / 2)
		upper = int(height * 1/3)
		cropped_screenshot = screenshot.crop((left, upper, width, height))
	else:
		cropped_screenshot = screenshot
	#Отладочный скрин
	debug_coef_path = "debug_coef_screenshot.png"
	cropped_screenshot.save(debug_coef_path)
	for chat_id in subscribers:
		send_photo(chat_id, debug_coef_path, caption="Скрин коэффициента (обрезанный)")
	
	time.sleep(1)
	
	# Получаем OCR-текст и ищем число
	full_text, _ = extract_text_google_vision(cropped_screenshot)
	telegram_log(f"[DEBUG] OCR текст коэффициента: {full_text}")
	
	matches = re.findall(r"\b\d+(?:\.\d+)?\b", full_text)
	if matches:
		coef_str = matches[0].replace(",", ".")
		try:
			coefficient = float(coef_str)
			return coefficient
		except Exception as e:
			telegram_log(f"[ERROR] Ошибка преобразования OCR результата в число: {e}")
			return None
	else:
		return None

def parse_coefficient_from_text(text):
    """
    Извлекает первое число вида XX или XX.XX/XX,XX из строки text.
    Возвращает float или None.
    """
    # Ищем числа с точками или запятыми
    matches = re.findall(r"\b\d+[\.,]\d+\b|\b\d+\b", text)
    if matches:
        # Берем первое совпадение
        coef_str = matches[0]
        # Заменяем запятые на точки
        coef_str = coef_str.replace(",", ".")
        try:
            return float(coef_str)
        except (ValueError, TypeError):
            return None
    return None

def find_bet_input_coords():
	"""
	Ищем координаты для ввода суммы среди двух наборов:
	  - Сначала перебираем BET_INPUT_CANDIDATES_SET1 (до 3 попыток).
	  - Если не находим нужный цвет, скроллим чуть вниз, затем «мотнём» обратно вверх
		и делаем скриншот цены, после чего пробуем BET_INPUT_CANDIDATES_SET2.

	Возвращает кортеж (x, y) или None, если ничего не нашли.
	"""
	def check_candidates_set(candidates):
		tries = 0
		for candidate in candidates:
			region = (candidate[0], candidate[1], 5, 5)  # маленький квадрат 5x5
			screenshot_candidate = pyautogui.screenshot(region=region)
			# for cid in subscribers:
			#\ttemp_path = "temp_debug.png"
			#\tscreenshot_candidate.save(temp_path)
			#\tsend_photo(cid, temp_path, caption="Отладочный скриншот")
			stat = ImageStat.Stat(screenshot_candidate)
			avg_color = tuple(int(c) for c in stat.mean)
			telegram_log(f"[DEBUG] Кандидат {candidate}: средний цвет {avg_color}")
			if all(abs(avg_color[i] - TARGET_COLOR[i]) <= COLOR_TOLERANCE for i in range(3)):
				return candidate
			tries += 1
			if tries >= 3:
				break
		return None

	# 1) Сначала пробуем первый набор координат
	found = check_candidates_set(BET_INPUT_CANDIDATES_SET1)
	if found:
		return found
	else:
		telegram_log("Пытаюсь крутить!")
		# Скроллим чуть вниз
		pyautogui.click(1181,573)
		time.sleep(0.5)
		pyautogui.scroll(-2)
		found = (1218, 590)
		time.sleep(1)
		return found


async def verify_coefficient(bet_coords, expected_condition):
    """
    Проверяет коэффициент с точной областью захвата.
    Использует логику из старой версии с правильными координатами.
    """
    # Ждем стабилизации интерфейса
    await human_like_delay(0.5, 0.8)

    # Определяем область для скриншота коэффициента в зависимости от выбранного кандидата
    if bet_coords in BET_INPUT_CANDIDATES_SET1:
        coef_region = (
            bet_coords[0] - COEFFICIENT_SCREENSHOT_PADDING_X,
            bet_coords[1] - COEFFICIENT_SCREENSHOT_SHIFT_Y,
            2 * COEFFICIENT_SCREENSHOT_PADDING_X,
            COEFFICIENT_SCREENSHOT_PADDING_BOTTOM
        )
    else:
        coef_region = (1212, 594, 50, 20)  # Координаты из старой версии

    for attempt in range(3):
        try:
            # 1. Делаем скриншот области коэффициента
            screenshot = pyautogui.screenshot(region=coef_region)
            
            # 2. Обрезаем скриншот (логика из старой версии)
            if bet_coords in BET_INPUT_CANDIDATES_SET1:
                width, height = screenshot.size
                left = int(width / 2)
                upper = int(height * 1/3)
                cropped_screenshot = screenshot.crop((left, upper, width, height))
            else:
                cropped_screenshot = screenshot

            # 3. Сохраняем для отладки
            debug_path = f"coef_debug_{attempt}.png"
            cropped_screenshot.save(debug_path)

            # 4. Распознаем текст
            full_text, _ = extract_text_google_vision(cropped_screenshot)
            telegram_log(f"[DEBUG] OCR текст коэффициента: {full_text}")

            # 5. Извлекаем коэффициент (логика из старой версии)
            found_coef = None
            matches = re.findall(r"\b\d+(?:\.\d+)?\b", full_text)
            if matches:
                try:
                    found_coef = float(matches[0].replace(",", "."))
                except ValueError:
                    pass

            # 6. Проверяем условие
            if found_coef and check_coefficient_condition(found_coef, expected_condition):
                return found_coef

            # 7. Отправляем скриншот при ошибке
            for chat_id in subscribers:
                send_photo(chat_id, debug_path,
                           caption=f"Попытка {attempt+1}: Распознано '{full_text}' | Ожидаем '{expected_condition}'")

            await human_like_delay(0.5, 1.0)

        except Exception as e:
            telegram_log(f"Ошибка верификации: {str(e)}")
            await human_like_delay(0.5, 1.0)

    # Финальный скриншот при полной ошибке
    final_debug_path = "coef_final_debug.png"
    pyautogui.screenshot(final_debug_path, region=coef_region)
    for chat_id in subscribers:
        send_photo(chat_id, final_debug_path,
                   caption="Не удалось верифицировать коэффициент после 3 попыток")

    return None


async def find_outcome(outcome, coef_condition, bet_amount, raw=None):
    """
    Улучшенный поиск и обработка исхода с:
    - Непрерывным мониторингом ROI во время выполнения
    - Отменой при падении ROI ниже минимального
    - Таймаутом при отсутствии обновлений
    - Подробным логированием всех этапов
    - Человекообразными задержками и действиями
    """
    # Конфигурация
    PREDEFINED_OUTCOME_COORDS = {
        "1": (243, 573),
        "X": (399, 573),
        "2": (555, 572)
    }
    OUTCOME_SEARCH_REGION = (220, 273, 938, 691)
    RETRY_COORDS = (1254, 363)
    CLEANUP_CLICKS = [
        (618, 529),  # Клик по пустой области
        (1118, 473), # Дополнительный клик
        (997, 601)   # Удаление ставки из корзины
    ]

    try:
        # ===== 1. Инициализация мониторинга =====
        monitor_task = None
        if raw:
            monitor_task = asyncio.create_task(
                monitor_active_bet_while_processing(raw)
            )

        # ===== 2. Поиск и выбор исхода =====
        telegram_log(f"Начинаем обработку исхода: {outcome}")

        # Проверка ROI перед началом действий
        if raw and await should_cancel_bet(raw):
            telegram_log("Отмена: ROI упал ниже минимального")
            return False

        # Для предопределенных исходов используем жесткие координаты
        if outcome in PREDEFINED_OUTCOME_COORDS:
            coords = PREDEFINED_OUTCOME_COORDS[outcome]
            pyautogui.click(coords[0], coords[1])
            await human_like_delay(0.8, 1.2)
        else:
            # Для других исходов - поиск через OCR
            coords, matched_text = await optimized_search_for_outcome_async(
                outcome.strip(),
                OUTCOME_SEARCH_REGION,
                raw=raw
            )
            
            if not coords:
                telegram_log("Исход не найден после поиска")
                return False
                
            telegram_log(f"Найден исход: {matched_text}")
            
            human_like_move_to(coords[0], coords[1])
            await human_like_delay(0.3, 0.7)
            pyautogui.click()
            await human_like_delay(1.0, 1.5)

        # ===== 3. Ввод суммы ставки =====
        if raw and await should_cancel_bet(raw):
            await cancel_current_bet()
            return False

        bet_coords = find_bet_input_coords()
        if not bet_coords:
            telegram_log("Не найдено поле для ввода суммы")
            await click_retry()
            return False

        human_like_move_to(bet_coords[0], bet_coords[1])
        await human_like_delay(0.2, 0.5)
        pyautogui.click(clicks=2)
        
        for char in str(bet_amount):
            if raw and await should_cancel_bet(raw):  # Проверка во время ввода
                return False
            pyautogui.write(char, interval=random.uniform(0.1, 0.3))
            if random.random() < 0.2:
                await human_like_delay(0.05, 0.15)
        
        await human_like_delay(0.8, 1.2)

        # ===== 4. Проверка коэффициента =====
        found_coef = await verify_coefficient(bet_coords, coef_condition)
        if not found_coef:
            telegram_log(f"Коэффициент не соответствует условию: {coef_condition}")
            await click_retry()
            return False

        # ===== 5. Подтверждение ставки =====
        if random.random() < 0.3:  # 30% chance to scroll before confirm
            pyautogui.scroll(-random.randint(100, 300))
            await human_like_delay(0.3, 0.6)
            
        pyautogui.press("enter")
        telegram_log(f"Подтверждаем ставку {bet_amount} на кэф {found_coef}...")

        # ===== 6. Ожидание подтверждения =====
        if await wait_for_bet_confirmation():
            telegram_log(f"Успешная ставка! {outcome} {found_coef}x {bet_amount}")
            
            # Делаем скриншот результата
            result_region = (387, 238, 469, 322)
            result_screenshot = pyautogui.screenshot(region=result_region)
            result_text, _ = extract_text_google_vision(result_screenshot)
            
            if "Uspešno" in result_text:
                telegram_log("Ставка успешно принята!")
            else:
                telegram_log(f"Результат ставки: {result_text[:100]}...")
            
            return True
        
        telegram_log("Не получили подтверждение ставки")
        return False

    except pyautogui.FailSafeException:
        return False
        
    except Exception as e:
        error_msg = f"‼ Критическая ошибка в find_outcome: {str(e)}"
        telegram_log(error_msg)
        logging.exception(error_msg)
        return False
        
    finally:
        await clean_interface()
        
        # Отмена мониторинга
        if monitor_task and not monitor_task.done():
            monitor_task.cancel()


async def optimized_search_for_outcome_async(outcome, search_region,
                                             max_scroll_iterations=10,
                                             difference_threshold=30, raw=None):
    """
    Асинхронная версия поиска исхода через OCR с прокруткой.
    Возвращает (координаты, распознанный текст) или (None, None) если не найдено.
    """
    x1, y1, x2, y2 = search_region
    expected = outcome.lower().strip()

    for iteration in range(max_scroll_iterations):
        # Проверка ROI перед каждой итерацией
        if raw and await should_cancel_bet(raw):
            telegram_log(f"ROI упал ниже минимального - прерывание поиска")
            return None, None

        # Делаем скриншот и распознаем текст
        current_screenshot = pyautogui.screenshot(region=(x1, y1, x2-x1, y2-y1))
        full_text, results = extract_text_google_vision(current_screenshot)
        
        # Ищем совпадение в распознанном тексте
        for i, (vertices, text, confidence) in enumerate(results):
            if expected in text.lower():
                # Вычисляем координаты центра текстового блока
                xs = [v[0] for v in vertices]
                ys = [v[1] for v in vertices]
                center_x = x1 + (min(xs) + max(xs)) // 2
                center_y = y1 + (min(ys) + max(ys)) // 2
                return (center_x, center_y), text.strip()
        
        # Прокрутка вниз если не найдено
        pyautogui.scroll(-4)
        await human_like_delay(1.0, 1.5)

    return None, None


async def wait_for_bet_confirmation(timeout=10):
    """Ожидает подтверждения ставки"""
    region = (394, 526, 15, 15)
    target_color = (255, 255, 255)
    
    start = time.time()
    while time.time() - start < timeout:
        region_img = pyautogui.screenshot(region=region)
        stat = ImageStat.Stat(region_img)
        avg_color = tuple(int(c) for c in stat.mean)
        
        if all(abs(avg_color[i] - target_color[i]) <= 5 for i in range(3)):
            return True
        
        await asyncio.sleep(0.5)
    
    return False


async def clean_interface():
    """Очищает интерфейс после ставки"""
    try:
        await human_like_delay(0.5, 1)
        pyautogui.click(618, 529)  # Клик по пустой области
        await human_like_delay(0.3, 0.7)
        pyautogui.click(1118, 473)  # Дополнительный клик
        pyautogui.scroll(-300)
        pyautogui.click(997, 601)  # Удаление ставки из корзины
        await human_like_delay(0.5)
        pyautogui.click(619, 524)  # Закрытие всплывающих окон
        await human_like_delay(0.3, 0.6)
        pyautogui.click(581, 331)
    except Exception as e:
        telegram_log(f"Ошибка при очистке интерфейса: {str(e)}")


async def click_retry():
    """Клик по кнопке Retry с обработкой ошибок"""
    try:
        pyautogui.scroll(300)
        await human_like_delay(0.5)
        human_like_move_to(1254, 363)
        pyautogui.click()
    except Exception as e:
        telegram_log(f"Ошибка при клике Retry: {str(e)}")


def run_automatizator():
    """Запуск автоматизатора с правильной обработкой asyncio"""
    async def start():
        try:
            automatizator = Automatizator(put_bet, telegram_log)
            await automatizator.run()
        except asyncio.CancelledError:
            telegram_log("Автоматизатор остановлен")
        except Exception as e:
            telegram_log(f"ОШИБКА АВТОМАТИЗАТОРА: {str(e)}")
            raise

    def run_in_thread():
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(start())
        finally:
            loop.close()

    thread = threading.Thread(target=run_in_thread, daemon=True)
    thread.start()
    telegram_log("Автоматизатор запущен в отдельном потоке")

def main():
    """
    Точка входа: 
      - Загружаем подписчиков,
      - Стартуем поток для приёма Telegram-сообщений,
      - Шлём приветственное сообщение,
      - Открываем браузер и заходим на sansabet.com,
      - Ждём пока цвет в определённой точке не станет правильным,
      - Делаем логин,
      - Дальше идёт бесконечное ожидание, пока poll_updates обрабатывает ставки.
    """
    load_subscribers()
    
    # Запускаем обработчик Telegram сообщений в отдельном потоке
    def start_polling():
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        loop.run_until_complete(poll_updates())

    updater = threading.Thread(target=start_polling, daemon=True)
    updater.start()

    telegram_log("Бот запущен! Отправьте /start, чтобы получать логи бота.")

    # Даем время на запуск и открытие браузера
    time.sleep(5)
    
    # Открываем браузер и переходим на сайт
    open_browser_and_navigate()
    time.sleep(5)

    # Ждём пока сайт станет "готовым" по цвету
    SITE_READY_COLOR = (224, 175, 0)
    wait_for_site_ready_color(SITE_READY_COLOR, 10, (604, 119, 5, 5))

    # Выполняем логин
    do_login()
    time.sleep(5)

    # Запускаем автоматизатор
    automatizator_thread = threading.Thread(target=run_automatizator, daemon=True)
    automatizator_thread.start()

    # Основной цикл ожидания
    while True:
        time.sleep(1)

if __name__ == "__main__":
	main()