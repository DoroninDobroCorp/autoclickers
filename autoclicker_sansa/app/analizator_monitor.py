import asyncio
import websockets
import json
from datetime import datetime


class AnalyzerMonitor:
    def __init__(self):
        self.analyzer_ws_url = "ws://188.253.24.91:7300/output"
        self.bookmaker = "Sansabet"
        self.sports = ["Soccer", "Tennis"]
        self._stop_event = asyncio.Event()

    async def process_message(self, message: str):
        """Обработка и вывод сообщений анализатора"""
        try:
            data = json.loads(message)
            if not data:
                return

            timestamp = datetime.now().strftime("%H:%M:%S")

            for match in data:
                # Проверка обязательных полей
                if not all(key in match for key in ['second',
                                                    'outcome',
                                                    'sportName']):
                    continue

                # Фильтр по видам спорта
                if match['sportName'] not in self.sports:
                    continue

                # Извлечение основной информации
                match_name = match['second']['Raw']['match_name']
                sport = match['sportName']

                print(f"\n[{timestamp}] {sport}: {match_name}")
                print("-" * 50)

                # Обработка исходов
                for outcome in match['outcome']:
                    if not all(key in outcome for key in ['outcome',
                                                          'roi',
                                                          'score2']):
                        continue

                    outcome_name = outcome['outcome']
                    roi = outcome.get('roi', 0)
                    coef = outcome['score2']['value']

                    print(f"• Исход: {outcome_name:<20} | ROI: {roi:>5.1f}% | Коэф: {coef}")

                print("-" * 50)

        except json.JSONDecodeError as e:
            print(f"Ошибка декодирования JSON: {str(e)}")
        except Exception as e:
            print(f"Ошибка обработки сообщения: {str(e)}")

    async def connect_to_analyzer(self):
        """Подключение к анализатору и получение данных"""
        print("Подключаемся к анализатору...")
        while not self._stop_event.is_set():
            try:
                async with websockets.connect(self.analyzer_ws_url) as websocket:
                    print("Успешное подключение к анализатору")
                    print("Ожидаем сигналы...\n")

                    # Отправляем настройки фильтрации
                    await websocket.send(json.dumps({
                        "bookmakers": [{
                            "name": self.bookmaker,
                            "live": {
                                "filter": True,
                                "sports": self.sports
                            },
                            "prematch": {
                                "filter": False,
                                "sports": []
                            }
                        }]
                    }))

                    # Основной цикл получения сообщений
                    while not self._stop_event.is_set():
                        message = await websocket.recv()
                        await self.process_message(message)

            except Exception as e:
                print(
                    f"Ошибка соединения: {e}. Переподключение через 5 секунд"
                    )
                await asyncio.sleep(5)

    async def run(self):
        """Запуск монитора"""
        try:
            await self.connect_to_analyzer()
        except asyncio.CancelledError:
            print("Монитор остановлен")
        except Exception as e:
            print(f"Критическая ошибка: {e}")
        finally:
            self._stop_event.set()

    def stop(self):
        """Остановка монитора"""
        self._stop_event.set()


async def main():
    monitor = AnalyzerMonitor()
    try:
        await monitor.run()
    except KeyboardInterrupt:
        monitor.stop()
        print("\nМонитор остановлен по запросу пользователя")

if __name__ == "__main__":
    asyncio.run(main())
