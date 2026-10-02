import pytest
import json
from unittest.mock import AsyncMock, patch
from app.automatizator import Automatizator


@pytest.mark.asyncio
async def test_full_flow():
    put_bet_mock = AsyncMock(return_value=True)

    with patch('app.bot.put_bet', new=put_bet_mock):
        auto = Automatizator(put_bet_mock)

        # Имитируем сообщение от анализатора
        test_match = {
            "sportName": "Soccer",  # Добавляем обязательное поле
            "second": {
                "matchId": "123",
                "Raw": {"match_name": "TeamA vs TeamB"}
            },
            "outcome": [{
                "outcome": "1", 
                "roi": 1.5,
                "score2": {"raw": {}, "value": 2.1}
            }]
        }
        message = json.dumps([test_match])

        await auto.process_analyzer_message(message)
        assert auto.active_bet is not None