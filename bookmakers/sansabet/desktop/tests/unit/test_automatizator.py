import pytest
import json
from unittest.mock import AsyncMock
from dataclasses import asdict
from app.automatizator import Automatizator, Bet

@pytest.fixture
def auto():
    put_bet_mock = AsyncMock(return_value=True)
    return Automatizator(put_bet_mock)

@pytest.fixture
def test_match():
    return {
        "sportName": "Soccer",
        "second": {"matchId": "123", "Raw": {"match_name": "TeamA vs TeamB"}},
        "outcome": [{"outcome": "1", "roi": 1.5, "score2": {"raw": {}, "value": 2.1}}]
    }

@pytest.mark.asyncio
async def test_process_analyzer_message(auto, test_match):
    message = json.dumps([test_match])
    await auto.process_analyzer_message(message)
    
    assert len(auto.outcomes_cache) == 1
    assert auto.active_bet is not None
    assert auto.active_bet.match["second"]["matchId"] == "123"

@pytest.mark.asyncio
async def test_place_bet(auto, test_match):
    bet = Bet(
        match=test_match,
        outcome=test_match["outcome"][0]
    )
    
    await auto.place_bet(bet)
    
    auto.put_bet.assert_awaited_once()
    assert auto.active_bet == bet

@pytest.mark.asyncio
async def test_move_to_basket(auto, test_match):
    bet = Bet(
        match=test_match,
        outcome={"outcome": "1", "roi": 0.3}
    )
    auto.active_bet = bet
    
    await auto.move_to_basket()
    
    assert auto.active_bet is None
    assert len(auto.basket) == 1
    assert auto.basket[0] == bet

@pytest.mark.asyncio
async def test_cancel_bet(auto, test_match):
    bet = Bet(
        match=test_match,
        outcome={"outcome": "1", "roi": -1.0}
    )
    auto.active_bet = bet
    
    await auto.cancel_bet()
    
    assert auto.active_bet is None

# @pytest.mark.asyncio
# async def test_basket_timeout(auto, test_match):
#     import time
#     old_bet = Bet(
#         match=test_match,
#         outcome={"outcome": "1", "roi": 0.3},
#         added_at=time.time() - 130  # Старее чем timeout (120)
#     )
#     auto.basket.append(old_bet)
    
#     await auto.check_basket()
    
#     assert len(auto.basket) == 0