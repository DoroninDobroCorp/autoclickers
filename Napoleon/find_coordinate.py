import pyautogui
from pynput import keyboard
import json
import os

CONFIG_FILE = "config_napoleon.json"

# Загружаем существующую конфигурацию или создаём новую
if os.path.exists(CONFIG_FILE):
    with open(CONFIG_FILE, "r") as f:
        config = json.load(f)
else:
    config = {
        "site_url": "https://www.napoleonsports.be",
        "login_coords": {},
        "navigation": {},
        "outcome_coords": {},
        "bet_input_candidates": [],
        "ocr_settings": {
            "TARGET_COLOR": [255, 255, 255],
            "COLOR_TOLERANCE": 10
        },
        "retry_coords": [1254, 363]
    }

current_label = None

def record_position():
    pos = pyautogui.position()
    print(f"[INFO] Зафиксированы координаты для '{current_label}': X: {pos.x}, Y: {pos.y}")
    if current_label:
        parts = current_label.split('.')
        # Если метка имеет формат section.key, сохраняем в соответствующем разделе
        if len(parts) == 2:
            section, key = parts
            if section not in config:
                config[section] = {}
            config[section][key] = [pos.x, pos.y]
            print(f"[INFO] Сохранено: {section}[{key}] = {[pos.x, pos.y]}")
        else:
            # Если метка равна "bet_input_candidate", добавляем координаты в список кандидатов
            if current_label == "bet_input_candidate":
                if "bet_input_candidates" not in config:
                    config["bet_input_candidates"] = []
                config["bet_input_candidates"].append([pos.x, pos.y])
                print(f"[INFO] Добавлен кандидат для ввода ставки: {[pos.x, pos.y]}")
            else:
                print(f"[WARN] Неизвестная метка: {current_label}")
    else:
        print("[WARN] Метка не установлена!")

def set_label(label):
    global current_label
    current_label = label
    print(f"[INFO] Текущая метка установлена: {current_label}")

def exit_program():
    with open(CONFIG_FILE, "w") as f:
        json.dump(config, f, indent=4)
    print("[INFO] Конфигурация сохранена в", CONFIG_FILE)
    listener.stop()

hotkeys = keyboard.GlobalHotKeys({
    '<ctrl>+<shift>+r': record_position,
    '<ctrl>+<shift>+q': exit_program
})

print("[INFO] Режим калибровки запущен.")
print("Введите в консоли метку для элемента (например, 'login_coords.username', 'login_coords.password', 'navigation.live_coords', 'bet_input_candidate', и т.д.).")
print("Нажмите Ctrl+Shift+R, чтобы записать координаты для текущей метки.")
print("Нажмите Ctrl+Shift+Q, чтобы сохранить конфигурацию и выйти.")

listener = hotkeys
listener.start()

while True:
    label = input("Введите метку (или 'exit' для завершения): ")
    if label.lower() == "exit":
        exit_program()
        break
    else:
        set_label(label)