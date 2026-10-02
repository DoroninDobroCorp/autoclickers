import time
import threading

import pyperclip
import requests
import pyautogui
import os
import re
from PIL import ImageChops, ImageStat, Image

# Добавляем необходимые импорты для Google Cloud Vision API
import io
import logging
from google.cloud import vision
from config import BOT_TOKEN, PHONE_NUMBER, PASSWORD

global chosen_candidate

# Настройка переменных окружения и логирования для Google Cloud Vision API
os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = "sansabet-60de415fbcfc.json"
logging.basicConfig(level=logging.DEBUG, format='[%(levelname)s] %(message)s')

# ---------------------- Настройки Telegram-бота ----------------------
TELEGRAM_BOT_TOKEN = BOT_TOKEN
BASE_URL = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}"
SUBSCRIBERS_FILE = "subscribers.txt"
subscribers = set()

# Флаг для тестирования скриншотов (отправка в Telegram)
DEBUG_SCREENSHOT = False

# Инициализируем клиента Google Cloud Vision
vision_client = vision.ImageAnnotatorClient()


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
    url = f"{BASE_URL}/sendMessage"
    payload = {"chat_id": chat_id, "text": message}
    try:
        requests.post(url, data=payload)
    except Exception as e:
        print("Ошибка при отправке сообщения:", e)


def send_photo(chat_id, photo_path, caption=""):
    """Отправляет фото через Telegram"""
    url = f"{BASE_URL}/sendPhoto"
    try:
        with open(photo_path, "rb") as photo_file:
            files = {"photo": photo_file}
            data = {"chat_id": chat_id, "caption": caption}
            requests.post(url, data=data, files=files)
    except Exception as e:
        print("Ошибка при отправке фото:", e)


def telegram_log(message):
    """Отправляет сообщение всем подписчикам (используем для логов по распознаванию и т.п.)"""
    for chat_id in subscribers:
        send_message(chat_id, message)


def poll_updates():
    # При запуске бота получаем накопленные апдейты и вычисляем offset,
    # чтобы игнорировать старые сообщения.
    try:
        initial_response = requests.get(f"{BASE_URL}/getUpdates", params={"timeout": 1}, timeout=5)
        initial_data = initial_response.json()
        initial_updates = initial_data.get("result", [])
        if initial_updates:
            offset = initial_updates[-1]["update_id"] + 1
            print(f"[INFO] Пропущены старые сообщения, начинаем с offset: {offset}")
        else:
            offset = None
    except Exception as e:
        print("[ERROR] Ошибка при инициализации offset:", e)
        offset = None

    # Основной цикл опроса
    while True:
        params = {'timeout': 10, 'offset': offset}
        try:
            response = requests.get(f"{BASE_URL}/getUpdates", params=params, timeout=15)
            data = response.json()
            for update in data.get("result", []):
                offset = update["update_id"] + 1  # обновляем offset для следующих запросов
                message = update.get("message")
                if not message:
                    continue
                chat_id = str(message["chat"]["id"])
                text = message.get("text", "")

                # Обработка команды /start
                if text.lower() == "/start":
                    if chat_id not in subscribers:
                        subscribers.add(chat_id)
                        save_subscribers()
                        send_message(chat_id, "Вы подписались на логи бота!")
                        print(f"[INFO] Новый подписчик: {chat_id}")
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
                    try:
                        bet_amount = float(bet_amount_str.replace(",", "."))
                    except ValueError:
                        print("[ERROR] Размер ставки не является числом!")
                        telegram_log("Ошибка: Размер ставки не является числом!")
                        continue
                    find_match(match_name)
                    time.sleep(1)
                    result = find_outcome(outcome, coef_condition, bet_amount)
                    if result:
                        print("[INFO] Ставка успешно обработана!")
                        telegram_log("Ставка успешно обработана!")
                    else:
                        print("[INFO] Ставка не обработана, требуется повторная попытка.")
                        telegram_log("Ставка не обработана, требуется повторная попытка.")
        except Exception as e:
            print("Ошибка при получении обновлений:", e)
        time.sleep(1)


def open_browser_and_navigate():
    """
    Открываем olimp.bet (или другой нужный сайт) через адресную строку.
    """
    logging.debug("Открываем olimp.bet")
    pyautogui.hotkey('ctrl', 'l')
    time.sleep(1)
    pyautogui.click(505, 66)  # кликаем на адресную строку
    time.sleep(1)
    pyautogui.write("https://www.olimp.bet/", interval=0.2)
    pyautogui.press("enter")


def wait_for_site_ready_color(target_color, color_tolerance=10, check_region=(0, 100, 5, 5)):
    """
    Ждёт, пока в зоне check_region (5x5 пикселей) цвет не станет близким к target_color (± color_tolerance).
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
    Логинимся
    """
    print("[INFO] Выполняется логин...")
    pyautogui.click(1238, 123, clicks=1)
    time.sleep(1)

    pyautogui.click(708, 449, clicks=1)
    pyautogui.write(PHONE_NUMBER, interval=0.1)
    time.sleep(1)

    pyautogui.click(621, 523, clicks=1)
    pyautogui.write(PASSWORD, interval=0.1)

    pyautogui.click(617, 611, clicks=1)
    time.sleep(3)


def find_match(match_name):
    """
    Переходит в лайв и вводит название матча match_name в поиске.
    """
    logging.debug("Заходим в лайв и ищем матч")
    time.sleep(3)
    match_input_coords = (184, 189)
    match_click_coords = (606, 336)
    pyautogui.click(match_input_coords[0], match_input_coords[1])
    time.sleep(2)

    pyperclip.copy(match_name)  # Копируем текст в буфер обмена, так как write не работает для русских символов
    pyautogui.hotkey("command", "v")  # Вставляем текст
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
            debug_outcome_path = f"debug_outcome_screenshot_{iteration + 1}.png"
            current_screenshot.save(debug_outcome_path)
            for chat_id in subscribers:
                send_photo(chat_id, debug_outcome_path, caption=f"Тестовый скриншот, итерация {iteration + 1}")

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
        telegram_log(f"[DEBUG] Итерация {iteration + 1}\nПолный текст:\n{full_text.strip()}")

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
                        telegram_log(
                            f"[DEBUG] Найден исход путём объединения блоков {i}-{j}: '{current_combined}'. Координаты: {coords}")
                        return coords, matched_text
                else:
                    telegram_log(
                        f"[DEBUG] Объединение '{current_combined + ' ' + next_block}' не соответствует '{expected}'. Прерываем объединение.")
                    break

        previous_screenshot = current_screenshot
        pyautogui.scroll(-4)
        time.sleep(1)

    telegram_log("[ERROR] Не удалось найти исход после прокрутки.")
    return None, None


# ======================= Координаты и константы для ставок =======================

# Две группы координат для ввода ставки
BET_INPUT_CANDIDATES_SET1 = [(1225, 430)]  # пример
BET_INPUT_CANDIDATES_SET2 = [(1201, 657)]  # пример

# Цвет, который мы ожидаем увидеть на месте ввода суммы
TARGET_COLOR = (59, 59, 59)
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


def extract_coefficient_from_region(region):
    """
    Делаем скриншот заданной области, обрезаем её и через OCR вытаскиваем число.
    Используется для финальной проверки (после ввода суммы).
    """
    screenshot = pyautogui.screenshot(region=region)

    # Обрезаем правую половину и нижние 2/3
    # if chosen_candidate in BET_INPUT_CANDIDATES_SET1:
    #     width, height = screenshot.size
    #     left = int(width / 2)
    #     upper = int(height * 1 / 3)
    #     cropped_screenshot = screenshot.crop((left, upper, width, height))
    # else:
    #     cropped_screenshot = screenshot
    # Отладочный скрин
    debug_coef_path = "debug_coef_screenshot.png"
    screenshot.save(debug_coef_path)
    for chat_id in subscribers:
        send_photo(chat_id, debug_coef_path, caption="Скрин коэффициента (обрезанный)")

    time.sleep(1)

    # Получаем OCR-текст и ищем число
    # full_text, _ = extract_text_google_vision(cropped_screenshot)
    # telegram_log(f"[DEBUG] OCR текст коэффициента: {full_text}")

    # matches = re.findall(r"\b\d+(?:\.\d+)?\b", full_text)
    # if matches:
    #     coef_str = matches[0].replace(",", ".")
    #     try:
    #         coefficient = float(coef_str)
    #         return coefficient
    #     except Exception as e:
    #         telegram_log(f"[ERROR] Ошибка преобразования OCR результата в число: {e}")
    #         return None
    # else:
    #     return None


def parse_coefficient_from_text(text):
    """
    Извлекает первое число вида XX или XX.XX из строки text (например, "Barcelona 28.3").
    Возвращает float или None.
    """
    matches = re.findall(r"\b\d+(?:\.\d+)?\b", text)
    if matches:
        # Берём первое попавшееся
        coef_str = matches[0].replace(",", ".")
        try:
            return float(coef_str)
        except:
            return None
    return None


def find_bet_input_coords():
    """
    Ищем координаты для ввода
    Возвращает кортеж (x, y) или None, если ничего не нашли.
    """

    def check_candidates_set(candidates):
        tries = 0
        for candidate in candidates:
            region = (candidate[0], candidate[1], 5, 5)  # маленький квадрат 5x5
            screenshot_candidate = pyautogui.screenshot(region=region)
            # for cid in subscribers:
            #     temp_path = "temp_debug.png"
            #     screenshot_candidate.save(temp_path)
            #     send_photo(cid, temp_path, caption="Отладочный скриншот")
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


def find_outcome(outcome, coef_condition, bet_amount):
    global chosen_candidate
    """
    Функция для нахождения исхода матча и размещения ставки с проверкой коэффициента.

    Алгоритм (обновлённый):
      1. Если исход ("1", "X", "2") - кликаем по заранее заданным координатам.
      2. Иначе ищем текст исхода через optimized_search_for_outcome.
      3. Кликаем по найденному исходу.
      4. БЕЗ скриншота – извлекаем число (например, 28.3) прямо из текста, который распознан для исхода,
         и сравниваем с нашим условием coef_condition.
      5. Если ок — ищем координаты места ввода суммы (find_bet_input_coords).
         Вводим сумму, делаем вторую проверку кэфа (уже со скриншотом).
      6. Если кэф подходит, подтверждаем ставку, отправляем скриншот результата и делаем нужные клики.
      7. Если не подходит — скроллим вверх и жмём Retry.
    """
    PREDEFINED_OUTCOME_COORDS = {
        "1": (405, 549),
        "X": (521, 546),
        "2": (648, 547)
    }
    OUTCOME_SEARCH_REGION = (220, 273, 938, 691)
    FINISH_COORDS = (1160, 597)
    RETRY_COORDS = (1254, 363)

    # 1. Предопределённые координаты для "1", "X", "2"
    if outcome in PREDEFINED_OUTCOME_COORDS:
        coords = PREDEFINED_OUTCOME_COORDS[outcome]
        telegram_log(f"[DEBUG] Предопределённый исход '{outcome}' найден. Координаты для клика: {coords}")
        pyautogui.click(coords[0], coords[1])
        time.sleep(2)

        # Так как "1", "X", "2" обычно без доп. текста, принимаем кэф = None,
        # чтобы потом сразу переходить к вводу ставки (или можем пропустить проверку).
        found_coef_first = None

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
            time.sleep(2)
        else:
            telegram_log("[ERROR] Исход не найден!")
            return False

    # 5. Ищем координаты для ввода суммы
    chosen_candidate = find_bet_input_coords()
    if chosen_candidate is None:
        telegram_log("[ERROR] Не найдено место ввода с нужным цветом даже после скролла!")
        return False

    # Ввод суммы
    # 6. Ввод суммы для выбранного кандидата
    pyautogui.click(chosen_candidate[0], chosen_candidate[1], clicks=1)
    pyautogui.hotkey("command", "a")
    pyautogui.press("backspace")
    pyperclip.copy(str(bet_amount))
    pyautogui.hotkey("command", "v")
    pyautogui.click(1250, 528)
    time.sleep(2)
    pyautogui.scroll(300)

    # 7. Финальная проверка кэфа (со скриншотом)
    if chosen_candidate in BET_INPUT_CANDIDATES_SET1:
        coef_region_x = chosen_candidate[0] - COEFFICIENT_SCREENSHOT_PADDING_X
        coef_region_y = chosen_candidate[1] - COEFFICIENT_SCREENSHOT_SHIFT_Y
        coef_region_width = 2 * COEFFICIENT_SCREENSHOT_PADDING_X
        coef_region_height = COEFFICIENT_SCREENSHOT_PADDING_BOTTOM

    screenshot_coef = pyautogui.screenshot(region=(coef_region_x, coef_region_y, coef_region_width, coef_region_height))
    debug_coef_path = "debug_coef_screenshot.png"
    screenshot_coef.save(debug_coef_path)
    # for chat_id in subscribers:
    #     send_photo(chat_id, debug_coef_path, caption="Скрин коэффициента из новой области")

    time.sleep(1)
    found_coef = extract_coefficient_from_region((coef_region_x, coef_region_y, coef_region_width, coef_region_height))
    if found_coef is not None:
        telegram_log(f"[DEBUG] Извлечённый коэффициент (финальная проверка): {found_coef}")
        if check_coefficient_condition(found_coef, coef_condition):
            # Подтверждаем ставку: скроллим вниз, нажимаем Enter
            pyautogui.scroll(-300)
            time.sleep(0.5)
            pyautogui.press("enter")
            telegram_log(f"Ставка поставлена: Исход={outcome}, OCR Кэф={found_coef}, Сумма={bet_amount}.")

            # Ждем, пока регион (394,526,15,15) не покажет целевой цвет (255,255,255)
            max_attempts = 30
            attempt = 0
            region_to_check = (394, 526, 15, 15)
            target_color = (255, 255, 255)
            tolerance = int(255 * 0.02)  # примерно 5
            while attempt < max_attempts:
                region_screenshot = pyautogui.screenshot(region=region_to_check)
                stat = ImageStat.Stat(region_screenshot)
                avg_color = tuple(int(c) for c in stat.mean)
                telegram_log(f"[DEBUG] Проверка региона {region_to_check}: {avg_color}")
                if all(abs(avg_color[i] - target_color[i]) <= tolerance for i in range(3)):
                    break
                time.sleep(0.5)
                attempt += 1

            # Делаем скриншот результата с корректными размерами (верхний левый угол и размеры области)
            result_screenshot_region = (387, 238, 469, 322)
            result_screenshot = pyautogui.screenshot(region=result_screenshot_region)
            result_screenshot_path = "bet_result_screenshot.png"
            result_screenshot.save(result_screenshot_path)
            # for chat_id in subscribers:
            #     send_photo(chat_id, result_screenshot_path, caption="Результат ставки")

            # Распознаём текст результата и отправляем сообщение в Telegram
            full_text_result, _ = extract_text_google_vision(result_screenshot)
            if "Uspešno" in full_text_result:
                telegram_log("Ставка успешна!")
                telegram_log(full_text_result)
            else:
                telegram_log("Кажется ставка не удалась")
                telegram_log(full_text_result)

            # Дополнительные клики после оформления ставки
            time.sleep(0.5)
            pyautogui.click(618, 529)
            time.sleep(0.5)
            pyautogui.click(1118, 473)
            pyautogui.scroll(-300)
            pyautogui.click(997, 601)  # удаляем ставку из корзины
            time.sleep(0.5)
            pyautogui.click(619, 524)
            time.sleep(0.6)
            pyautogui.click(581, 331)
        else:
            # Если коэффициент не соответствует условиям, отменяем ставку
            pyautogui.scroll(300)
            time.sleep(0.5)
            pyautogui.click(RETRY_COORDS[0], RETRY_COORDS[1])
            telegram_log("Коэффициент (финальная проверка) не соответствует условиям. Ожидание новой ставки.")
            return False
    else:
        # Не смогли распознать кэф
        pyautogui.scroll(300)
        time.sleep(0.5)
        pyautogui.click(RETRY_COORDS[0], RETRY_COORDS[1])
        telegram_log("Не удалось распознать коэффициент (финальная проверка). Ожидание новой ставки.")
        return False

    return True


def main():
    """
    Точка входа:
      - Загружаем подписчиков,
      - Стартуем поток для приёма Telegram-сообщений,
      - Шлём приветственное сообщение,
      - Открываем браузер и заходим на olimp.bet,
      - Ждём пока цвет в определённой точке не станет правильным,
      - Делаем логин,
      - Дальше идёт бесконечное ожидание, пока poll_updates обрабатывает ставки.
    """
    load_subscribers()

    updater = threading.Thread(target=poll_updates, daemon=True)
    updater.start()

    telegram_log("Бот запущен! Отправьте /start, чтобы получать логи бота.")

    # Даем время на запуск и открытие браузера
    time.sleep(5)
    open_browser_and_navigate()
    time.sleep(5)

    # Ждём пока сайт станет "готовым" по цвету
    SITE_READY_COLOR = (191, 47, 38, 255)  # Укажите нужный цвет
    wait_for_site_ready_color(SITE_READY_COLOR, 10, (0, 100, 10, 10))

    do_login()
    telegram_log('Выполнен вход')
    time.sleep(5)

    # Просто ждём, пока в другом потоке poll_updates обрабатывает сообщения
    while True:
        time.sleep(1)


if __name__ == "__main__":
    main()