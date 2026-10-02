// Authenticated, DOM-only prepare-and-clear. Intentionally no place() method.
export function parseAmount(text) {
  const value = Number(String(text).replace(/[^\d.,-]/g, '').replace(',', '.'));
  return Number.isFinite(value) ? value : null;
}

export function eventIdFromUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== '1win.pro') return null;
    return url.pathname.match(/^\/betting\/match\/sport\/(?:.*-)?(\d+)\/?$/)?.[1] || null;
  } catch { return null; }
}

export class OneWinDryRunCart {
  constructor(page) { this.page = page; this.busy = false; this.blocked = []; }

  async installGuard() {
    if (this.guarded) return;
    this.guarded = true;
    await this.page.route('**/*', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() === 'POST' && /(?:place.?bet|bet.?place|create.?bet|bets?\/create|bets?\/submit|wager)/i.test(path)) {
        this.blocked.push(path);
        return route.abort();
      }
      return route.continue();
    });
    // Defense in depth against accidental submit clicks in this test page.
    const preventSubmit = () => document.addEventListener('click', e => {
      const button = e.target.closest?.('button');
      if (button && /^(?:place a bet|place bet|bet now|сделать ставку|поставить)$/i.test(button.innerText.trim())) {
        e.preventDefault(); e.stopImmediatePropagation();
      }
    }, true);
    await this.page.addInitScript(preventSubmit);
    await this.page.evaluate(preventSubmit);
  }

  slip() {
    // The app nests the coupon aside in the sports-sidebar aside. Taking
    // every ancestor duplicated the same coupon after its first add.
    return this.page.getByText('Betslip', {exact:true}).locator('xpath=ancestor::aside[1]');
  }

  async clear() {
    const slip = this.slip();
    const empty = slip.getByText('Select an outcome', {exact:false});
    if (await empty.isVisible()) return true;
    const trash = slip.getByRole('button').filter({has:this.page.locator('[style*="trash.svg"]')});
    if (await trash.count() === 1 && await trash.isVisible()) await trash.click({timeout:5000});
    // The site offers a five-second undo. Completion means the empty state,
    // not the optimistic deletion banner, and never presses its Cancel/undo.
    await empty.waitFor({state:'visible', timeout:8000});
    return true;
  }

  async run(plan, {screenshot, cancelled = async()=>false} = {}) {
    if (this.busy) throw new Error('ONEWIN_CART_BUSY');
    if (!plan?.ok || !plan.selection || !plan.ui_selection_name) throw new Error('EXACT_PLAN_REQUIRED');
    const selection = plan.selection;
    const url = new URL(selection.event_url);
    if (url.protocol !== 'https:' || url.hostname !== '1win.pro'
      || url.pathname !== `/betting/match/sport/${selection.event_id}`) throw new Error('UNSAFE_EVENT_URL');
    this.busy = true;
    const started = performance.now();
    const result = {ok:false, dry_run:true, external_placement:false, cart_cleared:false,
      event_id:selection.event_id, market_id:selection.market_id, selection_id:selection.selection_id,
      market:selection.market_name, selection:plan.ui_selection_name, phases:{}};
    const phase = async (name, action) => {
      result.stage = name;
      const start = performance.now();
      try { return await action(); } finally { result.phases[name] = Math.round(performance.now()-start); }
    };
    try {
      await this.installGuard();
      if (await cancelled()) throw new Error('CANCELLED');
      await phase('navigation', async()=>{
        if (eventIdFromUrl(this.page.url()) !== selection.event_id) {
          await this.page.goto(selection.event_url,{waitUntil:'domcontentloaded',timeout:20000});
        }
        await this.slip().getByText('Betslip',{exact:true}).waitFor({timeout:10000});
      });
      await phase('initial_cleanup',()=>this.clear());
      if (await cancelled()) throw new Error('CANCELLED');
      await phase('exact_selection',async()=>{
        const title = this.page.getByText(selection.market_name,{exact:true}).filter({visible:true});
        const group = title.locator('xpath=ancestor::div[.//button[.//span[starts-with(@class,"_cf_")]]][1]');
        const button = group.getByRole('button').filter({has:this.page.getByText(plan.ui_selection_name,{exact:true})});
        await button.waitFor({state:'visible',timeout:8000});
        if (await group.count() !== 1 || await button.count() !== 1) throw new Error('AMBIGUOUS_EXACT_OUTCOME');
        result.board_price = parseAmount(await button.locator('span[class^="_cf_"]').innerText());
        if (!(result.board_price > 1)) throw new Error('INVALID_BOARD_PRICE');
        await button.click({timeout:5000});
      });
      await phase('basket_readback',async()=>{
        const slip = this.slip();
        const expected = `${selection.market_name}, ${plan.ui_selection_name}`;
        await slip.getByText(expected,{exact:true}).waitFor({timeout:5000});
        const amount = slip.locator('input[data-qa="amount"]:visible');
        // fill() appends on this masked input (10 → 101). Use real editing and
        // assert the value after blur; never assume the requested string stuck.
        await amount.click();
        await amount.press('ControlOrMeta+A');
        await amount.press('Backspace');
        await amount.pressSequentially('1');
        await amount.press('Tab');
        result.amount = parseAmount(await amount.inputValue());
        if (result.amount !== 1) throw new Error('AMOUNT_READBACK_MISMATCH');
        result.basket_text = (await slip.innerText()).replace(/USDT\s*[\d.,]+/g,'USDT [amount]').slice(0,550);
        if (screenshot) await slip.screenshot({path:screenshot});
      });
      result.ok = true;
    } catch (error) {
      result.error = String(error.message || error).slice(0,600);
    } finally {
      const failedStage = result.stage;
      try { result.cart_cleared = await phase('cleanup',()=>this.clear()); }
      catch(error) { result.ok = false; result.cleanup_error = String(error.message || error).slice(0,400); }
      if (result.error) result.stage = failedStage;
      else result.stage = result.cart_cleared ? 'completed' : 'cleanup';
      result.elapsed_ms = Math.round(performance.now()-started);
      result.blocked_submit_requests = this.blocked.length;
      if (this.blocked.length) result.ok = false;
      this.busy = false;
    }
    return result;
  }
}
