import { chromium } from "playwright";

(async () => {
  const browser = await chromium.launch({
    headless: true,
    proxy: { server: "socks5://127.0.0.1:10800" },
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled"
    ]
  });
  const context = await browser.newContext({
    storageState: "/srv/betting/robinarb/current/backend/stats_data/onewin-session-state.json",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
    viewport: { width: 1440, height: 900 }
  });
  const page = await context.newPage();

  page.on("request", req => {
    if (req.method() === "POST" || req.url().includes("auth") || req.url().includes("user") || req.url().includes("login")) {
      console.log("REQ:", req.method(), req.url());
      if (req.method() === "POST") {
        try { console.log("  POST:", req.postData()?.slice(0, 300)); } catch(e){}
      }
    }
  });

  page.on("response", async res => {
    const url = res.url();
    if (url.includes("auth") || url.includes("user") || url.includes("login") || url.includes("session")) {
      console.log("RES:", res.status(), url);
      try {
        const text = await res.text();
        console.log("  BODY:", text.slice(0, 300));
      } catch(e){}
    }
  });

  await page.addInitScript(() => {
    let _initGeetest4 = window.initGeetest4;
    Object.defineProperty(window, "initGeetest4", {
      configurable: true,
      enumerable: true,
      get: () => _initGeetest4,
      set: (fn) => {
        _initGeetest4 = function(config, callback) {
          return fn(config, function(captchaObj) {
            window._myGtObj = captchaObj;
            const origOnSuccess = captchaObj.onSuccess;
            captchaObj.onSuccess = function(handler) {
              console.log("1win registered onSuccess handler!");
              window._1winOnSuccess = handler;
              return origOnSuccess.call(this, handler);
            };
            return callback(captchaObj);
          });
        };
      }
    });
  });

  page.on("console", msg => console.log("LOG:", msg.text()));

  await page.goto("https://1win.pro", { timeout: 35000, waitUntil: "load" });
  await page.waitForTimeout(2000);
  await page.getByRole("button", { name: /Вход/i }).first().click();
  await page.waitForTimeout(1000);

  const dialog = page.locator("div[role=\"dialog\"], [class*=\"modal\"], [class*=\"dialog\"]").first();
  await dialog.getByRole("button", { name: /Почта/i }).or(dialog.getByText("Почта", { exact: true })).first().click();
  await page.waitForTimeout(500);

  await page.locator("[data-testid=\"signInByEmail-form-email\"]").fill("mamalamapanorama@gmail.com");
  await page.locator("[data-testid=\"signInByEmail-form-password\"]").fill("Doronin7");
  await page.waitForTimeout(500);

  await page.locator("[data-testid=\"signInByEmail-form-submit\"]").click();
  console.log("Clicked submit! Monitoring validate token...");

  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(1000);
    const res = await page.evaluate(() => {
      if (!window._myGtObj) return { step: "waiting for gtObj" };
      const val = window._myGtObj.getValidate();
      if (val && window._1winOnSuccess) {
        console.log("Invoking 1win onSuccess with validate!");
        try {
          window._1winOnSuccess();
          return { step: "invoked", val };
        } catch(err) {
          return { step: "error", err: err.message };
        }
      }
      return { step: "waiting for validate", hasVal: !!val, hasHandler: !!window._1winOnSuccess };
    });
    console.log("Poll " + i + ":", JSON.stringify(res));
    if (res.step === "invoked") break;
  }

  console.log("Waiting 10s after invoke...");
  await page.waitForTimeout(10000);

  await context.storageState({ path: "/srv/betting/robinarb/current/backend/stats_data/onewin-session-state.json" });

  const header = (await page.locator("header").innerText().catch(() => "")).replace(/\n/g, " ");
  console.log("Final Header:", header);

  await browser.close();
})();
