from dotenv import find_dotenv, load_dotenv
import os

if not find_dotenv():
    exit('Переменные окружения не загружены т.к. отсутствует файл .env')
else:
    load_dotenv()

BOT_TOKEN = os.getenv('BOT_TOKEN')
PHONE_NUMBER = os.getenv("PHONE_NUMBER")
PASSWORD = os.getenv("PASSWORD")