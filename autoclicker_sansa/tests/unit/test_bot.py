import pytest
from unittest.mock import patch, MagicMock
from app.bot import (
    check_coefficient_condition,
    parse_coefficient_from_text,
    find_bet_input_coords
)


@pytest.fixture(autouse=True)
def mock_google_vision():
    with patch('google.cloud.vision.ImageAnnotatorClient') as mock_client:
        mock_instance = mock_client.return_value
        mock_instance.text_detection.return_value.text_annotations = []
        yield


@pytest.mark.parametrize("coef,condition,expected", [
    (1.5, ">1.1", True),
    (1.5, "<2.0", True),
    (1.5, ">1.1 <2.0", True),
    (1.5, "1.5", True),
    (1.5, ">2.0", False),
    (1.5, "<1.0", False),
])
def test_check_coefficient_condition(coef, condition, expected):
    assert check_coefficient_condition(coef, condition) == expected


@pytest.mark.parametrize("text,expected", [
    ("Barcelona 2.5", 2.5),
    ("Коэффициент: 1,75", 1.75),
    ("1.83 (123)", 1.83),
    ("No numbers here", None),
])
def test_parse_coefficient_from_text(text, expected):
    assert parse_coefficient_from_text(text) == expected


@patch('pyautogui.screenshot')
def test_find_bet_input_coords(mock_screenshot):
    mock_img = MagicMock()
    mock_img.size = (5, 5)
    stat_mock = MagicMock()
    stat_mock.mean = (218, 218, 218)
    with patch('PIL.ImageStat.Stat', return_value=stat_mock):
        mock_screenshot.return_value = mock_img
        result = find_bet_input_coords()
        assert result is not None