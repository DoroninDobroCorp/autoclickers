// Authenticated, DOM-only prepare-and-clear. Intentionally no place() method.
import { TransportGuard, DEFAULT_BET_API_ORIGINS, READ_ONLY_POST_PATHS } from './transport_guard.mjs';

export function parseAmount(text) {
  let numeric = String(text).trim().replace(/^[A-Z]{3,6}\s+/i, '').trim();
  // The English coupon masks 9999 as "USDT 9,999.00". Commas in a
  // correctly grouped number are thousands separators, not decimal points.
  if (/^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(numeric)) numeric = numeric.replaceAll(',', '');
  else if (/^-?\d+,\d{1,2}$/.test(numeric)) numeric = numeric.replace(',', '.');
  else if (!/^-?\d+(?:\.\d+)?$/.test(numeric)) return null;
  const value = Number(numeric);
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
  constructor(page, { transportPolicy = {}, onWsFrame = null } = {}) {
    this.page = page;
    this._onWsFrame = onWsFrame;
    this.busy = false;
    this.blocked = [];            // money mutations the page tried (path list)
    this.blockedUnknown = [];     // other non-read transport the page tried: {kind, path, reason}
    this._guard = null;
    this.transportPolicy = {
      betApiOrigins: Array.isArray(transportPolicy.betApiOrigins) ? [...transportPolicy.betApiOrigins] : [...DEFAULT_BET_API_ORIGINS],
      readOnlyPostPaths: Array.isArray(transportPolicy.readOnlyPostPaths) ? [...transportPolicy.readOnlyPostPaths] : [...READ_ONLY_POST_PATHS],
      blockWorkers: transportPolicy.blockWorkers !== false,
    };
  }

  // Read-only means no money mutation by ANY transport: HTTP (default-deny for every non-read
  // request that is not a proven read endpoint), WebSocket frames (allow-list), workers and
  // service workers (removed), popups (context-level routing). See transport_guard.mjs.
  async installGuard() {
    if (this.guarded && this._guard) return;
    const guard = new TransportGuard({
      page: this.page,
      mode: 'read_only',
      betApiOrigins: this.transportPolicy.betApiOrigins,
      readOnlyPostPaths: this.transportPolicy.readOnlyPostPaths,
      blockWorkers: this.transportPolicy.blockWorkers,
      onWsFrame: this._onWsFrame,
      onBlocked: ({ kind, path, reason, money }) => {
        if (money) this.blocked.push(path);
        else this.blockedUnknown.push({ kind, path, reason });
      },
    });
    await guard.install();
    this._guard = guard;
    this.guarded = true;
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
        // A document that predates the guard may hold sockets or workers outside it: leave it.
        await this._guard.ensureFreshDocument();
        if (eventIdFromUrl(this.page.url()) !== selection.event_id) {
          await this.page.goto(selection.event_url,{waitUntil:'domcontentloaded',timeout:20000});
        }
        await this.slip().getByText('Betslip',{exact:true}).waitFor({timeout:10000});
      });
      await phase('transport_coverage', async()=>{
        const verdict = await this._guard.verifyCoverage();
        result.transport_coverage = verdict.checks || null;
        if (!verdict.ok) {
          const failed = Object.entries(verdict.checks || {}).filter(([,ok])=>ok!==true).map(([name])=>name);
          throw new Error(`TRANSPORT_GUARD_UNVERIFIED:${failed.join(',') || verdict.error || 'unknown'}`);
        }
      });
      await phase('initial_cleanup',()=>this.clear());
      if (await cancelled()) throw new Error('CANCELLED');
      await phase('exact_selection',async()=>{
        const title = this.page.getByText(selection.market_name,{exact:true}).filter({visible:true});
        // Ignore navigation tabs with the same title. Only an actual market
        // group may contribute its exact outcome buttons.
        const group = title.locator('xpath=ancestor::*[@data-scope="ListGroup"][1]');
        const button = group.getByRole('button').filter({has:this.page.getByText(plan.ui_selection_name,{exact:true})});
        await button.first().waitFor({state:'visible',timeout:8000});
        // Several full market groups can share their displayed title. The
        // exact selection within those groups must still be unique. This
        // prepares a read-only coupon; it does not certify execution IDs.
        if (await button.count() !== 1) throw new Error('AMBIGUOUS_EXACT_OUTCOME');
        result.market_title_candidates = await group.count();
        result.board_price = parseAmount(await button.locator('span[class^="_cf_"]').innerText());
        if (!(result.board_price > 1)) throw new Error('INVALID_BOARD_PRICE');
        if (selection.price !== undefined && (!Number.isFinite(selection.price)
          || selection.price <= 1 || selection.price !== result.board_price)) throw new Error('BOARD_PRICE_CHANGED');
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
      result.blocked_unknown_transport = this.blockedUnknown.slice(0, 50);
      result.transport_guard = this._guard ? this._guard.report() : null;
      if (this.blocked.length) result.ok = false;
      this.busy = false;
    }
    return result;
  }
}
