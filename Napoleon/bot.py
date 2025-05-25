import time
import threading
import requests
import pyautogui
import os
import re
import json
from PIL import Image, ImageStat, ImageChops
import io
from google.cloud import vision

# Загрузка конфигурации из файла config_napoleon.json (должен располагаться в той же папке, что и bot.py)
with open("config_napoleon.json", "r") as f:
    CONFIG = json.load(f)

# Подключение Google Cloud Vision API
os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = "app/vovkaproject-1c326021c3bf.json"
vision_client = vision.ImageAnnotatorClient()

# Настройки Telegram-бота
TELEGRAM_BOT_TOKEN = ""  # ← Вставьте свой токен бота
BASE_URL = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}"
SUBSCRIBERS_FILE = "subscribers.txt"
subscribers = set()
DEBUG_SCREENSHOT = False

# Функция для распознавания текста через Google Cloud Vision
def extract_text_google_vision(pil_image):
    if pil_image.mode != "RGB":
        pil_image = pil_image.convert("RGB")
    buf = io.BytesIO()
    pil_image.save(buf, format="JPEG")
    image = vision.Image(content=buf.getvalue())
    response = vision_client.text_detection(image=image)
    texts = response.text_annotations
    if not texts:
        return "", []
    full_text = texts[0].description
    results = []
    for annotation in texts[1:]:
        vertices = [(v.x, v.y) for v in annotation.bounding_poly.vertices]
        confidence = getattr(annotation, "score", None)
        results.append([vertices, annotation.description, confidence])
    return full_text, results

# Функции для работы с Telegram (отправка сообщений, логирование, загрузка/сохранение подписчиков)
def send_message(chat_id, message):
    requests.post(f"{BASE_URL}/sendMessage", data={"chat_id": chat_id, "text": message})

def telegram_log(message):
    for cid in subscribers:
        send_message(cid, message)

def load_subscribers():
    if os.path.exists(SUBSCRIBERS_FILE):
        with open(SUBSCRIBERS_FILE, "r") as f:
            for line in f:
                subscribers.add(line.strip())

def save_subscribers():
    with open(SUBSCRIBERS_FILE, "w") as f:
        for sub in subscribers:
            f.write(f"{sub}\n")

def send_photo(chat_id, photo_path, caption=""):
    try:
        with open(photo_path, "rb") as photo_file:
            files = {"photo": photo_file}
            data = {"chat_id": chat_id, "caption": caption}
            requests.post(f"{BASE_URL}/sendPhoto", data=data, files=files)
    except Exception as e:
        print("Ошибка при отправке фото:", e)

# Функции для навигации в браузере и авторизации на сайте
def open_browser_and_navigate():
    pyautogui.hotkey("ctrl", "l")
    time.sleep(1)
    # Используем URL, заданный в конфигурации (ожидается, что он указывает на napoleonsports.be)
    pyautogui.write(CONFIG["site_url"], interval=0.05)
    pyautogui.press("enter")

def do_login():
    coords = CONFIG["login_coords"]
    # Вход в систему: нажимаем на поля и вводим данные (при необходимости)
    pyautogui.click(*coords["username"])
    pyautogui.write("", interval=0.1)
    time.sleep(1)
    pyautogui.click(*coords["password"])
    pyautogui.write("", interval=0.1)
    time.sleep(1)
    pyautogui.click(*coords["submit"])
    time.sleep(3)
    pyautogui.click(*coords["popup_close"])
    time.sleep(2)

# Функция для поиска матча
def find_match(match_name):
    nav = CONFIG["navigation"]
    pyautogui.click(*nav["live_coords"])
    time.sleep(2)
    pyautogui.click(*nav["match_input_coords"])
    time.sleep(1)
    pyautogui.write(match_name, interval=0.05)
    time.sleep(1)
    pyautogui.click(*nav["match_click_coords"])
    time.sleep(2)

# Функция для поиска поля ввода ставки по цвету
def find_bet_input_coords():
    candidates = CONFIG["bet_input_candidates"]
    target = CONFIG["ocr_settings"]["TARGET_COLOR"]
    tol = CONFIG["ocr_settings"]["COLOR_TOLERANCE"]
    for coord in candidates:
        screenshot = pyautogui.screenshot(region=(coord[0], coord[1], 5, 5))
        avg = tuple(int(c) for c in ImageStat.Stat(screenshot).mean)
        if all(abs(avg[i] - target[i]) <= tol for i in range(3)):
            return coord
    return None

# Функция для проверки соответствия коэффициента заданному условию (например, >1.2 или <3)
def check_coefficient_condition(found_coef, condition_str):
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

# Функция для объединённого поиска исхода с использованием OCR и прокрутки страницы
def optimized_search_for_outcome(outcome, outcome_search_region, max_scroll_iterations=10, difference_threshold=30):
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
        if previous_screenshot is not None:
            diff = ImageChops.difference(previous_screenshot, current_screenshot)
            stat = ImageStat.Stat(diff)
            mean_diff = sum(stat.mean) / len(stat.mean)
            if mean_diff < difference_threshold:
                telegram_log("[INFO] Нет существенных изменений, возможно, достигнут низ страницы.")
                break
        full_text, results = extract_text_google_vision(current_screenshot)
        n = len(results)
        for i in range(n):
            candidate = results[i][1].strip().lower()
            if not expected.startswith(candidate):
                continue
            current_combined = candidate
            if current_combined == expected:
                coords = get_combined_top_left(results, i, 1)
                return coords, results[i][1].strip()
            for j in range(i+1, min(i+4, n)):
                next_block = results[j][1].strip().lower()
                potential = current_combined + " " + next_block
                if expected.startswith(potential):
                    current_combined = potential
                    if current_combined == expected:
                        coords = get_combined_top_left(results, i, j - i + 1)
                        combined_text = " ".join(results[k][1].strip() for k in range(i, j+1))
                        return coords, combined_text
                else:
                    break
        previous_screenshot = current_screenshot
        pyautogui.scroll(-4)
        time.sleep(1)
    telegram_log("[ERROR] Исход не найден после прокрутки.")
    return None, None

# Функция для поиска исхода и проставления ставки
def find_outcome(outcome, coef_condition, bet_amount):
    global chosen_candidate
    # Предопределённые координаты для исходов "1", "X", "2"
    PREDEFINED_OUTCOME_COORDS = {
        "1": (243, 573),
        "X": (399, 573),
        "2": (555, 572)
    }
    OUTCOME_SEARCH_REGION = CONFIG["outcome_coords"]["OUTCOME_SEARCH_REGION"]
    RETRY_COORDS = CONFIG.get("retry_coords", [0, 0])  # Дополнительно, если есть координаты Retry

    # Если исход является одним из стандартных вариантов
    if outcome in PREDEFINED_OUTCOME_COORDS:
        coords = PREDEFINED_OUTCOME_COORDS[outcome]
        telegram_log(f"[DEBUG] Предопределённый исход '{outcome}' найден: {coords}")
        pyautogui.click(*coords)
        time.sleep(2)
    else:
        outcome = outcome.strip()
        found_coords, recognized_text = optimized_search_for_outcome(outcome, OUTCOME_SEARCH_REGION)
        if found_coords is not None:
            telegram_log(f"[DEBUG] Исход '{outcome}' найден по OCR: {found_coords}")
            pyautogui.click(*found_coords)
            time.sleep(2)
        else:
            telegram_log("[ERROR] Исход не найден!")
            return False

    # Поиск поля ввода суммы
    chosen_candidate = find_bet_input_coords()
    if chosen_candidate is None:
        telegram_log("[ERROR] Поле ввода ставки не найдено!")
        return False

    # Ввод суммы ставки
    pyautogui.click(*chosen_candidate, clicks=2)
    pyautogui.write(str(bet_amount), interval=0.1)
    time.sleep(1)

    # Финальная проверка коэффициента: делаем скриншот области рядом с полем ввода
    coef_region = (chosen_candidate[0] - 120, chosen_candidate[1] - 40, 100, 40)
    screenshot_coef = pyautogui.screenshot(region=coef_region)
    full_text, _ = extract_text_google_vision(screenshot_coef)
    match = re.search(r"[0-9]+(?:[.,][0-9]+)?", full_text)
    if not match:
        telegram_log("Коэффициент не распознан!")
        return False

    found_coef = float(match.group(0).replace(",", "."))
    if not check_coefficient_condition(found_coef, coef_condition):
        telegram_log(f"Коэффициент {found_coef} не удовлетворяет условию {coef_condition}")
        return False

    # Подтверждаем ставку
    pyautogui.press("enter")
    telegram_log(f"Ставка проставлена: Исход={outcome}, Коэффициент={found_coef}, Сумма={bet_amount}")
    return True

# Функция опроса Telegram (poll_updates) – принимает сообщения, обрабатывает команды и ставки
def poll_updates():
    offset = None
    while True:
        try:
            response = requests.get(f"{BASE_URL}/getUpdates", params={"timeout": 10, "offset": offset})
            updates = response.json().get("result", [])
            for update in updates:
                offset = update["update_id"] + 1
                msg = update.get("message", {})
                chat_id = str(msg.get("chat", {}).get("id", ""))
                text = msg.get("text", "")
                if not chat_id or not text:
                    continue
                if text.lower() == "/start":
                    if chat_id not in subscribers:
                        subscribers.add(chat_id)
                        save_subscribers()
                    send_message(chat_id, "Вы подписались на бота.")
                else:
                    telegram_log(f"Получена ставка: {text}")
                    parts = [x.strip() for x in text.split(",")]
                    if len(parts) != 4:
                        telegram_log("Неверный формат. Пример: матч, исход, >1.2, 10")
                        continue
                    match_name, outcome, coef_condition, bet_amount_str = parts
                    try:
                        bet_amount = float(bet_amount_str.replace(",", "."))
                    except:
                        telegram_log("Ошибка: сумма ставки не число.")
                        continue
                    find_match(match_name)
                    time.sleep(1)
                    result = find_outcome(outcome, coef_condition, bet_amount)
                    if result:
                        telegram_log("✅ Ставка успешно проставлена.")
                    else:
                        telegram_log("❌ Ошибка при проставлении ставки.")
        except Exception as e:
            print("Ошибка в poll_updates():", e)
        time.sleep(1)

# Основная функция запуска бота
def main():
    load_subscribers()
    threading.Thread(target=poll_updates, daemon=True).start()
    telegram_log("Бот запущен! Отправьте /start для подписки.")
    time.sleep(5)
    open_browser_and_navigate()
    time.sleep(5)
    # Ждем, пока сайт загрузится; можно добавить проверку по цвету, если необходимо
    do_login()
    while True:
        time.sleep(1)

if __name__ == "__main__":
    main()