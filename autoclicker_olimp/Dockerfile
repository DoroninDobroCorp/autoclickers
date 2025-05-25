FROM ubuntu:20.04

ENV DEBIAN_FRONTEND=noninteractive

# Обновляем систему и устанавливаем системные зависимости,
# включая дополнительные библиотеки для работы с изображениями.
RUN apt-get update && apt-get install -y \
    xvfb \
    x11vnc \
    fluxbox \
    wget \
    ca-certificates \
    dbus-x11 \
    xterm \
    firefox \
    python3 \
    python3-pip \
    python3-dev \
    python3-tk \
    gnome-screenshot \
    tesseract-ocr \
    libsm6 \
    libxext6 \
    libxrender-dev \
    libnss3 \
    libasound2 \
    g++ \
    nano \
    libjpeg-dev \
    zlib1g-dev \
    libpng-dev \
    libtiff-dev \
    libfreetype6-dev \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# Устанавливаем Python-библиотеки, включая google-cloud-vision
RUN pip3 install --no-cache-dir \
    pyautogui \
    pynput \
    opencv-python \
    "Pillow>=9.2.0" \
    pytesseract \
    google-cloud-vision \
    numpy \
    requests \
    dotenv

# Копируем файлы приложения
WORKDIR /app
COPY . /app

# Делаем скрипт запуска исполняемым
RUN chmod +x /app/start.sh

# Настраиваем переменные окружения:
# DISPLAY для GUI-приложений и GOOGLE_APPLICATION_CREDENTIALS для Google Cloud Vision
ENV DISPLAY=:99
ENV GOOGLE_APPLICATION_CREDENTIALS=/app/app/sansabet-60de415fbcfc.json

# Запускаем start.sh при старте контейнера, который, в свою очередь, запускает bot.py
CMD ["/app/start.sh"]