import logging
import time
import threading
import requests
import pyautogui
import os
import datetime
# Импорт для работы с изображениями
import io
import re

import random

from google.cloud import vision
from PIL import ImageChops, ImageStat, Image
from urllib.parse import quote  

# Настройка переменных окружения и логирования для Google Cloud Vision API
os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = "app/vovkaproject-1c326021c3bf.json"
logging.basicConfig(level=logging.DEBUG, format='[%(levelname)s] %(message)s')

# ---------------------- Настройки Telegram-бота (на данном этапе не используются) ----------------------
TELEGRAM_BOT_TOKEN = "7612080865:AAHv8TZDkTBcwqf8tfGEpuQMYi9XqfU_NuM"
BASE_URL = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}"
SUBSCRIBERS_FILE = "subscribers.txt"
subscribers = set()
# Инициализация клиента Google Cloud Vision
vision_client = vision.ImageAnnotatorClient()

# Фиксированные координаты для стандартных исходов на странице поиска
PREDEFINED_OUTCOME_COORDS = {
    "1": (483, 570),
    "X": (543, 570),
    "2": (606, 570)
}
# Область поиска для OCR (на странице матча)
OUTCOME_SEARCH_REGION = (206, 255, 749, 537)  # (x1, y1, x2, y2)
#OUTCOME_SEARCH_REGION = (206, 235, 1200, 790)  # Увеличиваем правую и нижнюю границы


def extract_text_google_vision(pil_image, context=""):
    """Распознавание текста с предварительной отправкой скриншота"""
    max_retries = 7
    for attempt in range(max_retries):
        try:
            # Сохраняем временный файл
            debug_filename = f"debug_{datetime.datetime.now().strftime('%H%M%S')}.jpg"
            pil_image.save(debug_filename, "JPEG", quality=85)
            
            # Отправляем скриншот в Telegram
            for chat_id in subscribers:
                send_photo(
                    chat_id, 
                    debug_filename,
                    caption=f"🕵️ OCR Preview: {context}\n"
                            f"Size: {pil_image.size}\n"
                            f"Mode: {pil_image.mode}"
                )
            
            # Удаляем временный файл
            os.remove(debug_filename)
            
        except Exception as e:
            telegram_log(f"⚠️ Ошибка отправки скриншота: {str(e)}")


        try:
            # Оптимизация изображения
            if pil_image.mode != "RGB":
                pil_image = pil_image.convert("RGB")
            # Сохранение в буфер с высоким качеством
            buf = io.BytesIO()
            pil_image.save(buf, format="JPEG", quality=95, optimize=True)
            image_content = buf.getvalue()

            # Запрос с увеличенным таймаутом
            image = vision.Image(content=image_content)
            response = vision_client.text_detection(image=image, timeout=30)

            # Обработка ошибок API
            if response.error.message:
                error_msg = response.error.message
                if "quota" in error_msg.lower():
                    telegram_log("🔴 Превышены квоты Google Vision API!")
                    return "", []
                else:
                    telegram_log(f"❌ Ошибка Vision API: {error_msg}")
                    return "", []
                
            texts = response.text_annotations
            results = []
            for annotation in texts[1:]:
                vertices = [(v.x, v.y) for v in annotation.bounding_poly.vertices]
                confidence = getattr(annotation, 'score', None)
                results.append([vertices, annotation.description, confidence])
            return texts[0].description, results
            
        except Exception as e:
            error_msg = str(e)
            sleep_time = 2 ** attempt + random.uniform(0, 2)
            if any(code in error_msg for code in ['503', '500', 'RST_STREAM']):
                telegram_log(f"🌐 Сетевая ошибка ({error_msg}), повтор через {sleep_time:.1f}s...")
                time.sleep(sleep_time)
            else:
                raise
        telegram_log("🔴 Превышено максимальное количество попыток")
        return "", []

    
    
    

        

    """Добавлены повторные попытки при сбоях."""
    max_retries = 5
    for attempt in range(max_retries):
        try:
            """Использует Google Cloud Vision API для распознавания текста."""
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
                # После получения результатов от Google Vision
                if not results:
                    telegram_log("[WARNING] Нет данных OCR для обработки. Продолжаем прокрутку.")
                    continue
            return full_text, results
            telegram_log(f"[DEBUG] Полный текст OCR:\n{full_text}")
            telegram_log(f"[DEBUG] Координаты блоков: {results}")
        except Exception as e:
            error_msg = str(e)
            sleep_time = 2 ** attempt
            if any(code in error_msg for code in ['503', '500', 'RST_STREAM']):
                telegram_log(f"🌐 Сетевая ошибка ({error_msg}), повтор через {sleep_time}s...")
                time.sleep(sleep_time)
            else:
                raise
    return "", []
    

def load_subscribers():
    global subscribers
    print(f"[INFO] Загрузка подписчиков из файла {SUBSCRIBERS_FILE}")
    if os.path.exists(SUBSCRIBERS_FILE):
        with open(SUBSCRIBERS_FILE, "r") as f:
            for line in f:
                line = line.strip()
                if line:
                    subscribers.add(line)
        print(f"[INFO] Загружено подписчиков: {subscribers}")
        # Добавим принудительно себя как подписчика для тестов
        test_chat_id = "1106040252" # ID пользователя в Telegram
        if test_chat_id and test_chat_id not in subscribers:
            subscribers.add(test_chat_id)
            save_subscribers()
            print(f"[INFO] Добавлен тестовый подписчик: {test_chat_id}")
    else:
        print(f"[WARNING] Файл подписчиков {SUBSCRIBERS_FILE} не найден. Создаем новый.")
        with open(SUBSCRIBERS_FILE, "w") as f:
            f.write("")
        subscribers = set()
        # Добавим принудительно себя как подписчика
        test_chat_id = "1106040252" # ID пользователя в Telegram
        if test_chat_id:
            subscribers.add(test_chat_id)
            save_subscribers()
            print(f"[INFO] Добавлен тестовый подписчик: {test_chat_id}")

def save_subscribers():
    print(f"[INFO] Сохранение подписчиков в файл {SUBSCRIBERS_FILE}: {subscribers}")
    with open(SUBSCRIBERS_FILE, "w") as f:
        for sub in subscribers:
            f.write(f"{sub}\n")

def send_message(chat_id, message):
    url = f"{BASE_URL}/sendMessage"
    payload = {"chat_id": chat_id, "text": message}
    try:
        print(f"[INFO] Отправка сообщения '{message}' пользователю {chat_id}")
        response = requests.post(url, data=payload)
        print(f"[INFO] Ответ API на отправку: {response.status_code}, {response.text}")
        return response.status_code == 200
    except Exception as e:
        print("[ERROR] Ошибка при отправке сообщения:", e)
        return False

def send_photo(chat_id, photo_path, caption=""):
    #\"\"\"Отправляет фото через Telegram\"\"\"
    url = f"{BASE_URL}/sendPhoto"
    try:
        with open(photo_path, "rb") as photo_file:
            files = {"photo": photo_file}
            data = {"chat_id": chat_id, "caption": caption}
            requests.post(url, data=data, files=files)
    except Exception as e:
        print("Ошибка при отправке фото:", e)

def telegram_log(message):
    # Отправляет сообщение всем подписчикам (используем для логов по распознаванию и т.п.)
    print(f"[INFO] Отправка лога всем подписчикам: {message}")
    print(f"[INFO] Список подписчиков: {subscribers}")
    for chat_id in subscribers:
        send_message(chat_id, message)

def poll_updates():
    # При запуске бота получаем накопленные апдейты и вычисляем offset,
    # чтобы игнорировать старые сообщения.
    telegram_log("Запуск обработчика сообщений Telegram...")
    try:
        print("[INFO] Попытка получить начальные обновления...")
        initial_response = requests.get(f"{BASE_URL}/getUpdates", params={"timeout": 1}, timeout=5)
        print(f"[INFO] Ответ API: {initial_response.status_code}")
        initial_data = initial_response.json()
        print(f"[INFO] Данные ответа: {initial_data}")
        telegram_log(f"Подключение к API Telegram: {initial_response.status_code}")
        initial_updates = initial_data.get("result", [])
        if initial_updates:
            offset = initial_updates[-1]["update_id"] + 1
            print(f"[INFO] Пропущены старые сообщения, начинаем с offset: {offset}")
            telegram_log(f"Найдено {len(initial_updates)} старых сообщений, начинаем с offset: {offset}")
        else:
            offset = None
            print("[INFO] Начальных обновлений не найдено, offset не установлен")
            telegram_log("Начальных обновлений не найдено")
    except Exception as e:
        error_msg = f"[ERROR] Ошибка при инициализации offset: {e}"
        print(error_msg)
        telegram_log(error_msg)
        offset = None

    # Основной цикл опроса
    print("[INFO] Запуск основного цикла опроса Telegram API")
    telegram_log("Бот готов к приему сообщений...")
    while True:
        params = {'timeout': 10, 'offset': offset}
        try:
            print(f"[INFO] Запрос обновлений с параметрами: {params}")
            response = requests.get(f"{BASE_URL}/getUpdates", params=params, timeout=15)
            print(f"[INFO] Получен ответ: {response.status_code}")
            data = response.json()
            
            if not data.get("ok", False):
                error_msg = f"Ошибка API Telegram: {data.get('description', 'Unknown error')}"
                print(f"[ERROR] {error_msg}")
                telegram_log(error_msg)
                time.sleep(5)  # Увеличиваем интервал при ошибках
                continue
                
            updates = data.get("result", [])
            if updates:
                print(f"[INFO] Получено {len(updates)} новых сообщений")
                telegram_log(f"Получено {len(updates)} новых сообщений")
            
            for update in updates:
                offset = update["update_id"] + 1  # обновляем offset для следующих запросов
                message = update.get("message")
                if not message:
                    continue
                chat_id = str(message["chat"]["id"])
                text = message.get("text", "")
                print(f"[INFO] Обработка сообщения: {text} от {chat_id}")
                telegram_log(f"Сообщение от {chat_id}: {text}")

                # Обработка команды /start
                if text.lower() == "/start":
                    if chat_id not in subscribers:
                        subscribers.add(chat_id)
                        save_subscribers()
                        send_message(chat_id, "Вы подписались на логи бота!")
                        print(f"[INFO] Новый подписчик: {chat_id}")
                        telegram_log(f"Новый подписчик: {chat_id}")
                else:
                    # Обработка других сообщений (например, данных для ставки)
                    print(f"[INFO] Получены данные ставки от пользователя {chat_id}: {text}")
                    telegram_log(f"Получены данные ставки от пользователя {chat_id}: {text}")
                    parts = [part.strip() for part in text.split(",")]
                    if len(parts) != 4:
                        print("[ERROR] Неверный формат ставки! Ожидается: матч, Исход, кэф, размер ставки")
                        telegram_log("Неверный формат ставки!")
                        continue
                    match_name, outcome, coef_condition, bet_amount_str = parts
                    #match_name = normalize_text(parts[0])
                    try:
                        bet_amount = float(bet_amount_str.replace(",", "."))
                    except ValueError:
                        print("[ERROR] Размер ставки не является числом!")
                        telegram_log("Ошибка: Размер ставки не является числом!")
                        continue
                    #find_match(match_name)
                    time.sleep(1)
                    result = find_outcome(match_name, outcome, coef_condition, bet_amount)
                    if result:
                        time.sleep(5)                        
                        
                        # Проверка белого пикселя перед кликом
                        # Поле ввода ставки белого цвета - ищем его
                        # Координаты для проверки окна ввода ставки
                        BET_INPUT_CANDIDATES = [
                            (1200, 322),  # Основные координаты
                            (1200, 334)   # Альтернативные координаты
                        ]
                        found_input = False
                        selected_input_coords = None  # Новая переменная для хранения координат

                        # Проверяем все кандидаты
                        for x, y in BET_INPUT_CANDIDATES:
                            if check_white_pixel(x, y):
                                telegram_log(f"Окно ввода ставки обнаружено на ({x}, {y})")
                                pyautogui.click(x, y, clicks=1)
                                found_input = True
                                selected_input_coords = (x, y)  # Сохраняем выбранные координаты
                                break
                            else:
                                telegram_log(f"Окно ввода ставки ({x}, {y}) не обнаружено")

                        # Если ни одна координата не подошла, или не прогрузилась страница например
                        if not found_input:
                            telegram_log("Окно ввода не найдено! Возврат на главную страницу...")
                            pyautogui.hotkey('ctrl', 'l')
                            time.sleep(1)
                            pyautogui.write("https://www.marathonbet.ru/")
                            pyautogui.press("enter")
                            time.sleep(5)
                            continue  # Пропускаем текущую итерацию, возвращаемся к обработке новых сообщений
                                                                      
                        time.sleep(2)
                        pyautogui.write(str(bet_amount), interval=0.1)
                        time.sleep(2)  # Даем время для обновления интерфейса

                        # Проверяем желтый пиксель - сообщения об изменении коэффициента
                        # Если после установки ставки меняется кэф, принимаем его
                        if selected_input_coords == (1200, 334):
                            KEF_CHECK_X, KEF_CHECK_Y = 1017, 397 # Координаты для проверки жёлтого пикселя
                            CONFIRM_CLICK_X, CONFIRM_CLICK_Y = 1231, 396 # Координаты для клика подтверждения КЭФа
                            CONFIRM_X, CONFIRM_Y = 1214, 459#Кнопка подтверждения ставки
                        if selected_input_coords == (1200, 322):
                            KEF_CHECK_X, KEF_CHECK_Y = 1040, 354 # Координаты для проверки жёлтого пикселя
                            CONFIRM_CLICK_X, CONFIRM_CLICK_Y = 1246, 375 # Координаты для клика подтверждения КЭФа
                            CONFIRM_X, CONFIRM_Y = 1214, 439 #Кнопка подтверждения ставки


                        # Затем обновите условие проверки:
                        if check_yellow_pixel(KEF_CHECK_X, KEF_CHECK_Y):
                            telegram_log(f"Необходимо подтверждение нового коэффициента ({KEF_CHECK_X}, {KEF_CHECK_Y})")
                            pyautogui.click(CONFIRM_CLICK_X, CONFIRM_CLICK_Y)  # Клик по новым координатам
                            time.sleep(2)
                        else:
                            telegram_log("КЭФ не поменялся")

                        # Общий финальный клик подтверждения  
                        pyautogui.click(CONFIRM_X, CONFIRM_Y)  # Клик в любом случае

                        print("[INFO] Ставка успешно обработана!")
                        telegram_log("Ставка успешно обработана!")
                        time.sleep(20)
                    else:
                        print("[INFO] Ставка не обработана, требуется повторная попытка.")
                        telegram_log("Ставка не обработана, требуется повторная попытка.")
         
        except Exception as e:
            error_msg = f"[ERROR] Ошибка при получении обновлений: {e}"
            print(error_msg)
            # Если ошибка связана с получением обновлений, логируем только в консоль,
            # чтобы не создать бесконечный цикл ошибок при отправке в Telegram
            time.sleep(5)  # Увеличиваем интервал при ошибках
        time.sleep(1)

def open_browser_and_navigate():
    # Шаг 0: Авторизация через proxy
    pyautogui.click(413, 363)
    telegram_log("[STEP 0] Клик по координатам (413, 363) для ввода proxy")
    pyautogui.write("otwyn7rnye-res-country-RU-state-524894-city-524901-hold-session-session-67e908e575882", interval=0.05)
    telegram_log("[STEP 0] Введена proxy-строка")
    pyautogui.click(410, 396)
    telegram_log("[STEP 0] Клик по координатам (410, 396) для ввода данных авторизации")
    pyautogui.write("kVgpz87hTSt7wsF6")
    telegram_log("[STEP 0] Введён пароль")
    pyautogui.press("enter")
    telegram_log("[STEP 0] Нажат Enter для отправки данных авторизации")
    time.sleep(2)
    """
    Открываем www.marathonbet.ru (или другой нужный сайт) через адресную строку.
    """
    pyautogui.hotkey('ctrl', 'l')
    telegram_log("[STEP 1] Открыта адресная строка (ctrl+l)")
    time.sleep(1)
    pyautogui.write("https://www.marathonbet.ru/", interval=0.05)
    telegram_log("[STEP 1] Введён URL: https://www.marathonbet.ru/")
    pyautogui.press("enter")
    telegram_log("[STEP 1] Нажат Enter для открытия сайта")
    time.sleep(2)
    pyautogui.click(865, 669)

    
def do_login():
    # Примерный сценарий логина 
    telegram_log("[STEP 2] Логин")
    time.sleep(20)
    pyautogui.click(1138, 134)
    time.sleep(30)
    pyautogui.click(1138, 182)
    time.sleep(30)
    pyautogui.click(600, 377, clicks=2)
    pyautogui.write("9214111699", interval=0.1)
    time.sleep(1)
    pyautogui.click(600, 429, clicks=2)
    pyautogui.write("Gamma1488", interval=0.1)
    time.sleep(1)
    pyautogui.click(600, 516, clicks=1)
    time.sleep(2)

# ---------------------- Функция для проверки пикселя ----------------------
def check_white_pixel(x, y, tolerance=5):
    """
    Проверяет, является ли пиксель белым (все каналы > 255 - tolerance).
    """
    screenshot = pyautogui.screenshot(region=(x, y, 1, 1))
    pixel = screenshot.getpixel((0, 0))
    return all(channel > (255 - tolerance) for channel in pixel[:3])

def check_yellow_pixel(x, y, r_tolerance=10, g_tolerance=10, b_tolerance=10):
    """
    Проверяет, является ли пиксель жёлтым с ожидаемыми значениями RGB ~ (96, 100, 75).
    """
    screenshot = pyautogui.screenshot(region=(x, y, 1, 1))
    pixel = screenshot.getpixel((0, 0))
    r, g, b = pixel[:3]
    return (
        abs(r - 96) < r_tolerance and
        abs(g - 100) < g_tolerance and
        abs(b - 75) < b_tolerance
    )


# ---------------------- Функции для обработки ставок ----------------------
def find_match(match_name, need_ocr=False): #OCR используем только при необходимости
    encoded_match = quote(match_name)  # Кодируем название матча для URL
    search_url = f"https://www.marathonbet.ru/su/search.htm?searchText={encoded_match}"

    # Открывем страницу поиска
    pyautogui.hotkey('ctrl', 'l')
    telegram_log("[STEP 1] Открыта адресная строка (ctrl+l)")
    time.sleep(2)
    pyautogui.write(search_url, interval=0.05)  # Используем динамический URL
    time.sleep(1)
    pyautogui.press("enter")
    time.sleep(10)

    live_coords = (282, 359) # Координаты Live матчей

    pyautogui.click(live_coords)
    time.sleep(10)

     # Если нужен OCR (нестандартный исход) — переходим на страницу матча
    if need_ocr:
        pyautogui.click(269, 526)  # Клик по первому результату поиска (примерные координаты)
        time.sleep(30)  # Ждем загрузки страницы матча
        telegram_log(f"Открыта страница матча для OCR")
    else:
        telegram_log(f"Стандартный исход — остаемся на странице поиска")
        time.sleep(10)

def combine_adjacent_blocks(results, max_gap=20):
    """Объединяет смежные текстовые блоки с учетом расстояния между ними."""
    combined = []
    prev_right = 0
    current_group = []

    for item in sorted(results, key=lambda x: min(v[0] for v in x[0])):
        vertices = item[0]
        left = min(v[0] for v in vertices)
        
        if current_group and (left - prev_right) > max_gap:
            combined.append(current_group)
            current_group = []
        
        current_group.append(item)
        prev_right = max(v[0] for v in vertices)
    
    if current_group:
        combined.append(current_group)
    
    return combined


'''
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
    #expected = outcome.lower().strip()
    #expected = outcome.lower().strip().replace("(", "").replace(")", "").strip()  # Удаляем скобки для гибкости
    expected = (
        outcome.lower()
        .replace("(", "").replace(")", "")
        .replace(" ", "").strip()
    )

    for i in range(n):
        candidate = results[i][1].strip().lower()
        normalized_candidate = (
            candidate.replace("победа", "")
            .replace("(", "").replace(")", "")
            .replace(" ", "").strip()
        )
        
        # Проверка частичного совпадения
        if expected in normalized_candidate or normalized_candidate in expected:
            coords = get_combined_top_left(results, i, 1)
            matched_text = results[i][1].strip()
            telegram_log(f"Найден исход: '{normalized_candidate}' соответствует '{expected}'. Координаты: {coords}")
            return coords, matched_text
        
    def get_combined_top_left(results_list, start_idx, length):
        xs = []
        ys = []
        for offset in range(length):
            block_vertices = results_list[start_idx + offset][0]
            for (vx, vy) in block_vertices:
                xs.append(vx)
                ys.append(vy)
        return (x1 + min(xs), y1 + min(ys))

    try:
        for iteration in range(max_scroll_iterations):
            current_screenshot = pyautogui.screenshot(region=(x1, y1, region_width, region_height))
            time.sleep(2)
            if current_screenshot is None:
                telegram_log("Ошибка: Не удалось получить скриншот!")
                continue

            # Отправка отладочного скриншота
            debug_outcome_path = f"debug_outcome_screenshot_{iteration+1}.png"
            current_screenshot.save(debug_outcome_path, format="PNG")  # Явно указываем формат
            if os.path.exists(debug_outcome_path):
                telegram_log(f"Скриншот успешно сохранён: {debug_outcome_path}")
            else:
                telegram_log(f"Ошибка: Скриншот не сохранён!")
            telegram_log(f"[DEBUG] Распознанный текст на итерации {iteration+1}:\n{full_text.strip()}")
            for chat_id in subscribers:
                send_photo(chat_id, debug_outcome_path, caption=f"Скриншот OCR: {full_text[:50]}...")

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
            #telegram_log(f"[DEBUG] Итерация {iteration+1}\nПолный текст:\n{full_text.strip()}")

            n = len(results)
            # Перебираем OCR-блоки для поиска последовательного совпадения с ожидаемым исходом
            for i in range(n):
                candidate = results[i][1].strip().lower()
                if not expected.startswith(candidate):
                    continue

                current_combined = candidate
                coords = None  # Инициализация по умолчанию
                matched_text = None  # Инициализация по умолчанию
                
                # Если текущий блок полностью совпадает с ожидаемым, возвращаем координаты
                # Точное совпадение
                if current_combined == expected:
                    coords = get_combined_top_left(results, i, 1)
                    matched_text = results[i][1].strip()
                    telegram_log(f"[DEBUG] Найден исход в одном блоке: '{current_combined}'. Координаты: {coords}")
                    return coords, matched_text
                
                # Нормализация кандидата для гибкого сравнения
                normalized_candidate = (
                    candidate.replace("победа", "")
                    .replace("(", "").replace(")", "")
                    .replace(" ", "").strip()
                )

                # Проверка частичного совпадения  <--- ДОБАВЬТЕ ЭТОТ БЛОК
                if expected in normalized_candidate:
                    coords = get_combined_top_left(results, i, 1)
                    matched_text = results[i][1].strip()
                    telegram_log(f"[DEBUG] Частичное совпадение: '{expected}' в '{normalized_candidate}'. Координаты: {coords}")
                    return coords, matched_text

                 # Проверяем совпадение после нормализации
                if normalized_candidate == expected.replace(" ", ""):
                    # Получаем координаты только если условие выполнено
                    coords = get_combined_top_left(results, i, 1)
                    matched_text = results[i][1].strip()
                    telegram_log(f"[DEBUG] Найден исход после нормализации: '{normalized_candidate}'. Координаты: {coords}")
                    return coords, matched_text

                # Пробуем объединить с последующими блоками (до 3-х дополнительных)
                for j in range(i + 1, min(i + 6, n)):  # Было i + 4
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
            pyautogui.scroll(-4)
            time.sleep(3)
            telegram_log(f"[DEBUG] Итерация {iteration+1} | Распознанный текст: {full_text[:150]}...")
    
    except Exception as e:
        telegram_log(f"Ошибка в итерации {iteration}: {str(e)}")
    

    telegram_log("[ERROR] Не удалось найти исход после прокрутки.")
    return None, None
    '''

def is_element_visible(coords):
    """Проверяет видимость элемента по координатам"""
    x, y = coords
    return 0 <= x <= pyautogui.size().width and 0 <= y <= pyautogui.size().height

def check_green_coef_pixel(x, y):
    """Улучшенная проверка цвета коэффициента"""
    pixel = pyautogui.screenshot(region=(x, y, 1, 1)).getpixel((0, 0))
    return (40 < pixel[0] < 80) and (160 < pixel[1] < 200) and (40 < pixel[2] < 80)

def optimized_search_for_outcome(outcome, outcome_search_region, max_scroll_iterations=4, difference_threshold=30):
    import difflib

    def normalize_text(text):
        return (
            text.lower()
            .replace("(", "").replace(")", "")
            .replace(" ", "").replace("-", "")
            .translate(str.maketrans("", "", "!?,."))
            .replace("ё", "е")
        )

    # Разбиваем исход на командную часть и слово исхода
    parts = outcome.split()
    if len(parts) >= 2:
        outcome_word = parts[-1]  # тип исхода (например: победа)
        team_words = parts[:-1]   # название команды (например: ЦСКА Москва)
    else:
        outcome_word = outcome
        team_words = []

    norm_outcome = normalize_text(outcome_word)
    norm_team_parts = [normalize_text(w) for w in team_words]

    x1, y1, x2, y2 = outcome_search_region
    width, height = x2 - x1, y2 - y1

    def get_combined_top_left(results_list, indices):
        xs, ys = [], []
        for idx in indices:
            block_vertices = results_list[idx][0]
            for (vx, vy) in block_vertices:
                xs.append(vx)
                ys.append(vy)
        return (x1 + min(xs), y1 + min(ys))

    try:
        for iteration in range(max_scroll_iterations):
            screenshot = pyautogui.screenshot(region=(x1, y1, width, height))
            full_text, results = extract_text_google_vision(screenshot)

            telegram_log(f"🔍 Ищем: '{outcome}'")
            telegram_log(f"📄 Распознанный текст (итерация {iteration+1}):\n{full_text.strip()[:500]}")

            n = len(results)
            for i in range(n):
                combined = ""
                indices = []
                for j in range(i, min(i + 3, n)):
                    block_text = normalize_text(results[j][1])
                    combined += block_text
                    indices.append(j)

                    # Проверка по ключевым словам
                    outcome_match = norm_outcome in combined
                    team_match = all(part in combined for part in norm_team_parts)

                    if outcome_match and team_match:
                        coords = get_combined_top_left(results, indices)
                        telegram_log(f"✅ Найден текст '{combined}' на координатах {coords}")
                        return coords, combined

            pyautogui.scroll(-4)
            telegram_log(f"🔄 Прокрутка {iteration+1}/{max_scroll_iterations}")
            time.sleep(3)

    except Exception as e:
        telegram_log(f"🔥 Ошибка в поиске исхода: {str(e)}")

    telegram_log(f"❌ Исход '{outcome}' не найден после {max_scroll_iterations} попыток")
    return None, None




def get_combined_top_left(results_list, start_idx, num_blocks):
    """
    Вычисляет координаты верхнего левого угла для группы смежных OCR-блоков.
    
    Параметры:
    - results_list: список результатов OCR [(vertices, text, confidence), ...]
    - start_idx: начальный индекс первого блока в группе
    - num_blocks: количество блоков для объединения
    
    Возвращает:
    - Кортеж (x, y) с координатами верхнего левого угла объединенной области
    """
    if start_idx + num_blocks > len(results_list):
        raise ValueError("Недостаточно блоков для объединения")

    # Собираем все вершины из указанных блоков
    all_x = []
    all_y = []
    
    for i in range(start_idx, start_idx + num_blocks):
        vertices = results_list[i][0]  # Координаты вершин текущего блока
        for (x, y) in vertices:
            all_x.append(x)
            all_y.append(y)
    
    # Находим минимальные координаты
    min_x = min(all_x)
    min_y = min(all_y)
    
    # Корректируем координаты относительно области поиска
    x1, y1, _, _ = OUTCOME_SEARCH_REGION
    return (x1 + min_x, y1 + min_y)

def parse_coefficient_from_text(text):
    """Извлекает коэффициент из текста."""
    #matches = re.findall(r"\b\d+(?:\.\d+)?\b", text)
    #return float(matches[0].replace(",", ".")) if matches else None
    matches = re.findall(r"\b\d+[\.,]?\d*\b", text)  # Улучшенный паттерн
    return float(matches[-1].replace(",", ".")) if matches else None

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

def handle_bet_placement(bet_amount):
    """Обрабатывает ввод суммы ставки и подтверждение."""
    telegram_log(f"Начало обработки ставки: {bet_amount} RUB")
    # 1. Поиск поля ввода ставки по белым пикселям
    BET_INPUT_CANDIDATES = [
        (1200, 322),  # Основные координаты
        (1200, 334)   # Альтернативные координаты
    ]
    found_input = False
    selected_input_coords = None

    for x, y in BET_INPUT_CANDIDATES:
        if check_white_pixel(x, y):
            telegram_log(f"Поле ввода найдено: ({x}, {y})")
            pyautogui.click(x, y, clicks=2)  # Двойной клик для очистки поля
            time.sleep(1)
            found_input = True
            selected_input_coords = (x, y)
            break

    if not found_input:
        telegram_log("Ошибка: Поле ввода не найдено!")
        pyautogui.hotkey('ctrl', 'l')
        pyautogui.write("https://www.marathonbet.ru/")
        pyautogui.press("enter")
        time.sleep(5)
        return False
    
    # 2. Ввод суммы ставки
    pyautogui.write(str(bet_amount), interval=0.15)
    telegram_log(f"Введена сумма: {bet_amount}")
    time.sleep(2)

    # 3. Проверка изменения коэффициента
    if selected_input_coords == (1200, 334):
        KEF_CHECK = (1017, 397)  # Координаты желтого предупреждения
        CONFIRM_KEF = (1231, 396)  # Кнопка "Принять новый коэффициент"
        CONFIRM_BET = (1214, 459)  # Кнопка подтверждения ставки
    else:
        KEF_CHECK = (1040, 354)
        CONFIRM_KEF = (1246, 375)
        CONFIRM_BET = (1214, 439)

    if check_yellow_pixel(*KEF_CHECK):
        telegram_log("Обнаружено изменение коэффициента")
        pyautogui.click(*CONFIRM_KEF)
        time.sleep(1)

    # 4. Подтверждение ставки
    pyautogui.click(*CONFIRM_BET)
    telegram_log("Ставка подтверждена")
    
    # 5. Проверка успешности
    time.sleep(3)
    if check_green_pixel(CONFIRM_BET[0], CONFIRM_BET[1] + 50):
        telegram_log("Ставка успешно принята!")
        return True
    else:
        telegram_log("Ошибка подтверждения ставки")
        return False

def check_green_pixel(x, y, threshold=30):
    """Проверяет зеленый пиксель (успешное подтверждение)."""
    pixel = pyautogui.screenshot(region=(x, y, 1, 1)).getpixel((0, 0))
    return pixel[1] > 200 and pixel[0] < 50 and pixel[2] < 50  # RGB для зеленого

    return True  # Заглушка



def find_outcome(match_name, outcome, coef_condition, bet_amount):
    """Ищет исход ставки и делает ставку с указанной суммой."""
    print(f"[INFO] Поиск исхода: {outcome}, коэф: {coef_condition}, сумма: {bet_amount}")
    """
    Функция для нахождения исхода матча и размещения ставки с проверкой коэффициента.
    
    Алгоритм (обновлённый):
      1. Если исход ("1", "X", "2") - кликаем по заранее заданным координатам, прямо со страницы поиска.
      2. Иначе ищем текст исхода через optimized_search_for_outcome.
      3. Кликаем по найденному исходу.
      4. БЕЗ скриншота – извлекаем число (например, 28.3) прямо из текста, который распознан для исхода,
         и сравниваем с нашим условием coef_condition.
      5. Если ок — ищем координаты места ввода суммы (find_bet_input_coords).
         Вводим сумму, делаем вторую проверку кэфа (уже со скриншотом).
      6. Если кэф подходит, подтверждаем ставку, отправляем скриншот результата и делаем нужные клики.
      7. Если не подходит — скроллим вверх и жмём Retry.
    """


    # Определяем, является ли исход стандартным
    is_standard = outcome.strip() in PREDEFINED_OUTCOME_COORDS
    find_match(match_name, need_ocr=not is_standard)

    if is_standard:
        # Клик по фиксированным координатам
        coords = PREDEFINED_OUTCOME_COORDS[outcome]
        pyautogui.click(coords[0], coords[1])
        time.sleep(20)
        # ... логика ввода ставки ...
        return handle_bet_placement(bet_amount)
    else:
        # Поиск через OCR
        found_coords, text = optimized_search_for_outcome(
            outcome, 
            OUTCOME_SEARCH_REGION,
            #max_scroll_iterations=15
            max_scroll_iterations=4  # Было 15
        )
        if found_coords:
            telegram_log(f"✅ Найден исход: {text} | Координаты: {found_coords}")
            pyautogui.moveTo(found_coords[0], found_coords[1], duration=1)
            time.sleep(2)
            pyautogui.click(found_coords[0], found_coords[1])
            time.sleep(20)

            pyautogui.hotkey('ctrl', 'l')
            time.sleep(2)
            pyautogui.write("https://www.marathonbet.ru/")
            time.sleep(2)
            pyautogui.press("enter")
            time.sleep(20)

            return handle_bet_placement(bet_amount)
        return False
    
    telegram_log(f"Поиск матча: {match_name}")
    response = requests.get(search_url)
    if "События не найдены" in response.text:
        telegram_log(f"Матч '{match_name}' не найден!")
        return False
'''
    # 1. Предопределённые координаты для "1", "X", "2"
    if outcome in PREDEFINED_OUTCOME_COORDS:
        coords = PREDEFINED_OUTCOME_COORDS[outcome]
        telegram_log(f"[DEBUG] Предопределённый исход '{outcome}' найден. Координаты для клика: {coords}")
        pyautogui.click(coords[0], coords[1])
        telegram_log("[DEBUG] Клик выполнен")
        time.sleep(2)

        # Так как "1", "X", "2" обычно без доп. текста, принимаем кэф = None,
        # чтобы потом сразу переходить к вводу ставки (или можем пропустить проверку).
        found_coef_first = parse_coefficient_from_text(recognized_outcome_text)
        if found_coef_first and not check_coefficient_condition(found_coef_first, coef_condition):
            telegram_log(f"Коэффициент {found_coef_first} не соответствует условию {coef_condition}")
            return False
    else:
        # 2. Ищем исход
        outcome = outcome.strip()
        found_coords, recognized_outcome_text = optimized_search_for_outcome(
            outcome,
            OUTCOME_SEARCH_REGION,
            max_scroll_iterations=10,
            difference_threshold=30
        )
        if found_coords is not None:
            telegram_log(f"[DEBUG] Исход '{outcome}' найден по координатам: {found_coords}")
            # 3. Кликаем по найденному исходу
            pyautogui.click(found_coords[0], found_coords[1])
            time.sleep(5)
            time.sleep(20)
            pyautogui.click(found_coords[0], found_coords[1], clicks=1)
            time.sleep(10)
            pyautogui.click(1263, 230, clicks=1)
            time.sleep(2)
            pyautogui.click(1086, 380, clicks=1)
            time.sleep(5)
            
        else:
            telegram_log("[ERROR] Исход не найден!")
            return False

    # 5. Ищем координаты для ввода суммы
    # Ввод суммы
    # 6. Ввод суммы для выбранного кандидата

    return True
    '''

def test_ocr():
    test_image = Image.open("test_ocr.png")
    full_text, results = extract_text_google_vision(test_image)
    print("Распознанный текст:", full_text)
    print("Детали блоков:", results)    
   
# ---------------------- Основная функция ----------------------
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
    # Загружаем подписчиков
    load_subscribers()

    updater = threading.Thread(target=poll_updates, daemon=True)
    updater.start()

    # Даем время на запуск и открытие браузера
    time.sleep(5)
    open_browser_and_navigate()
    time.sleep(5)

    telegram_log("Бот запущен! Отправьте /start, чтобы получать логи бота.")

    do_login()
    time.sleep(5)

    # Просто ждём, пока в другом потоке poll_updates обрабатывает сообщения
    while True:
        time.sleep(1)
     
    #test_ocr()

if __name__ == "__main__":
    main()