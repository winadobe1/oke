/**
 * NetMirror Automated Session Harvester for Wins TV
 * 
 * Flow:
 * 1. Discover active NetMirror domain via bootstrap pool (check.php).
 * 2. Launch headless browser (Puppeteer) with Indonesian Residential Proxy.
 * 3. Open /mobile/home?app=1 and trigger ad verification.
 * 4. Wait for background verification to reach "All Done" (~25-35s).
 * 5. Extract verified cookies (t_hash_t + addhash).
 * 6. Validate session with a test search probe (assert status: "y").
 * 7. Write token.json directly to repository (Zero-Redis dependency!).
 * 8. Optional: Sync to Redis if credentials are provided.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// Try loading environment variables if .env exists
function loadEnv() {
  const envPaths = [
    path.join(__dirname, '../.env'),
    path.join(__dirname, '../.env.local'),
    path.join(__dirname, '../../wins-tv-app/.env.local'),
  ];
  for (const ep of envPaths) {
    if (fs.existsSync(ep)) {
      const content = fs.readFileSync(ep, 'utf8');
      content.split(/\r?\n/).forEach(line => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
          const idx = trimmed.indexOf('=');
          const key = trimmed.slice(0, idx).trim();
          const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
          if (!process.env[key]) {
            process.env[key] = val;
          }
        }
      });
    }
  }
}

loadEnv();

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const IS_TEST_ONLY = process.argv.includes('--test-only');

// Konfigurasi Residential Proxy (Default: Rainproxy Residential Jakarta, Indonesia)
const CONFIGURED_PROXY = process.env.PROXY_SERVER || process.env.RESIDENTIAL_PROXY || 'http://uy9rgc3e3tb-country-ID-state-jakarta_raya-city-jakarta-session-bpu5qzx6:p7c3vz7ey9tz@resi-bridge-us.rainproxy.io:3333';
let activeProxyUrl = CONFIGURED_PROXY;

function createProxyConfig(rawProxy) {
  if (!rawProxy) {
    return { rawUrl: null, host: null, auth: null, sessionId: null };
  }

  try {
    const pUrl = new URL(rawProxy);
    let username = decodeURIComponent(pUrl.username || '');
    let sessionId = null;

    // Rainproxy memakai bagian "-session-<id>" pada username untuk sticky IP.
    // Buat ID baru pada setiap browser/retry agar tidak terus memakai exit node
    // yang sedang lambat atau sudah dibatasi oleh target.
    if (/rainproxy\.io$/i.test(pUrl.hostname) && username) {
      sessionId = crypto.randomBytes(6).toString('hex');
      if (/-session-[a-z0-9]+/i.test(username)) {
        username = username.replace(/-session-[a-z0-9]+/i, `-session-${sessionId}`);
      } else {
        username += `-session-${sessionId}`;
      }
      pUrl.username = username;
    }

    const effectiveUrl = pUrl.toString();
    return {
      rawUrl: effectiveUrl,
      host: `${pUrl.protocol}//${pUrl.host}`,
      auth: pUrl.username && pUrl.password ? {
        username: decodeURIComponent(pUrl.username),
        password: decodeURIComponent(pUrl.password),
      } : null,
      sessionId,
    };
  } catch (e) {
    return { rawUrl: rawProxy, host: rawProxy, auth: null, sessionId: null };
  }
}

const HOST_POOL_B64 = [
  'aHR0cHM6Ly9tb2JpbGVkZXRlY3RzLmNvbQ==', 'aHR0cHM6Ly9tb2JpbGVkZXRlY3QuYXBw',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0LmFydA==',     'aHR0cHM6Ly9tb2JpZGV0ZWN0LmNj',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0LmNsaWNr',     'aHR0cHM6Ly9tb2JpZGV0ZWN0Lmluaw==',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0LmxpdmU=',     'aHR0cHM6Ly9tb2JpZGV0ZWN0LnBybw==',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0LnNob3A=',     'aHR0cHM6Ly9tb2JpZGV0ZWN0LnNpdGU=',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0LnNwYWNl',     'aHR0cHM6Ly9tb2JpZGV0ZWN0LnN0b3Jl',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0LnZpcA==',     'aHR0cHM6Ly9tb2JpZGV0ZWN0Lndpa2k=',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0Lnh5eg==',     'aHR0cHM6Ly9tb2JpZGV0ZWN0cy5hcnQ=',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0cy5jYw==',     'aHR0cHM6Ly9tb2JpZGV0ZWN0cy5pbmZv',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0cy5pbms=',     'aHR0cHM6Ly9tb2JpZGV0ZWN0cy5saXZl',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0cy5wcm8=',     'aHR0cHM6Ly9tb2JpZGV0ZWN0cy5zdG9yZQ==',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0cy50b3A=',     'aHR0cHM6Ly9tb2JpZGV0ZWN0cy54eXo=',
];

const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/136.0 Mobile Safari/537.36 /OS.Gatu v3.1';

async function discoverDomain() {
  console.log('[1/5] 🌐 Mencari domain aktif NetMirror...');
  for (const b64 of HOST_POOL_B64) {
    const host = Buffer.from(b64, 'base64').toString('utf-8');
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch(`${host}/check.php`, {
        headers: { 'User-Agent': MOBILE_UA },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      const data = await res.json().catch(() => null);
      if (data && data.token_hash) {
        const decoded = Buffer.from(data.token_hash, 'base64').toString('utf-8').replace(/\/+$/, '');
        const origin = new URL(decoded).origin;
        console.log(`   -> Terdeteksi domain aktif: ${origin} (via ${host})`);
        return origin;
      }
    } catch {}
  }
  const fallback = 'https://net52.cc';
  console.log(`   -> Menggunakan fallback domain: ${fallback}`);
  return fallback;
}

function resolvePuppeteer() {
  try {
    return require('puppeteer');
  } catch (e) {
    throw new Error('Puppeteer lengkap tidak ditemukan. Jalankan "npm install" agar Chromium bawaan Puppeteer ikut terpasang.');
  }
}

function describeNetMirrorIpMarker(addHash) {
  // NetMirror versi lama menambahkan marker eksplisit setelah pemisah "::".
  // Nilai setelah pemisah pada format baru dapat berupa hash opaque, jadi jangan
  // menebak tipe IP jika marker legacy memang tidak dikirim oleh server.
  const markerMatch = String(addHash || '').match(/(?:^|::)(di|su|bg)(?=::|$)/i);
  const marker = markerMatch?.[1]?.toLowerCase();

  if (marker === 'di') return '✅ RESIDENTIAL/DEVICE (marker legacy ::di)';
  if (marker === 'su') return '⚠️ DATACENTER/SERVER (marker legacy ::su)';
  if (marker === 'bg') return '⚠️ PROXY/BOT (marker legacy ::bg)';

  return 'ℹ️ FORMAT BARU/OPAQUE (server tidak mengirim marker tipe IP)';
}

async function openNetMirrorPage(puppeteer, origin) {
  const targetUrl = `${origin}/mobile/home?app=1`;
  const maxAttempts = 3;
  const bundledChromium = puppeteer.executablePath();
  let lastError = null;

  if (!bundledChromium || !fs.existsSync(bundledChromium)) {
    throw new Error('Chromium bawaan Puppeteer tidak ditemukan. Jalankan "npx puppeteer browsers install chrome".');
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const proxy = createProxyConfig(CONFIGURED_PROXY);
    activeProxyUrl = proxy.rawUrl;

    const launchOpts = {
      headless: 'new',
      executablePath: bundledChromium,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-web-security',
        '--disable-background-networking',
        '--disable-blink-features=AutomationControlled',
        '--window-size=390,844',
      ],
    };

    if (proxy.host) {
      launchOpts.args.push(`--proxy-server=${proxy.host}`);
      const sessionInfo = proxy.sessionId ? ` | Session baru: ${proxy.sessionId}` : '';
      console.log(`   -> 🌐 Proxy: ${proxy.host} (Targeting: Indonesia/Jakarta)${sessionInfo}`);
    }

    console.log(`   -> Percobaan navigasi ${attempt}/${maxAttempts} memakai Chromium bawaan Puppeteer`);

    let browser = null;
    let page = null;
    let blockInitialAssets = null;

    try {
      browser = await puppeteer.launch(launchOpts);
      page = await browser.newPage();

      if (proxy.auth) {
        await page.authenticate(proxy.auth);
      }

      await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
      await page.setUserAgent(MOBILE_UA);
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
      });

      // Popup iklan tidak diblokir agar request callback/tracking tetap berjalan.
      browser.on('targetcreated', async (target) => {
        if (target.type() !== 'page') return;
        try {
          const adPage = await target.page();
          if (!adPage) return;
          if (proxy.auth) await adPage.authenticate(proxy.auth);
          await adPage.setUserAgent(MOBILE_UA);
        } catch (e) {}
      });

      // Kurangi koneksi paralel hanya selama dokumen awal dimuat. Interception
      // dinonaktifkan lagi sebelum tombol iklan ditekan agar pixel iklan aman.
      await page.setRequestInterception(true);
      blockInitialAssets = (request) => {
        if (['image', 'font', 'media'].includes(request.resourceType())) {
          request.abort('blockedbyclient').catch(() => {});
        } else {
          request.continue().catch(() => {});
        }
      };
      page.on('request', blockInitialAssets);

      console.log(`   -> Membuka: ${targetUrl}`);
      const response = await page.goto(targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });

      await page.setRequestInterception(false).catch(() => {});
      page.off('request', blockInitialAssets);
      blockInitialAssets = null;

      const currentUrl = page.url();
      if (currentUrl.startsWith('chrome-error://')) {
        throw new Error(`Chromium membuka halaman error internal (${currentUrl}).`);
      }
      if (!response) {
        throw new Error('Navigasi selesai tanpa respons HTTP utama.');
      }

      return { browser, page, response, proxy };
    } catch (error) {
      lastError = error;
      const failedUrl = page && !page.isClosed() ? page.url() : '';
      const isRetryable = /ERR_(TIMED_OUT|PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED|CONNECTION_RESET|CONNECTION_CLOSED)/i.test(error.message)
        || failedUrl.startsWith('chrome-error://')
        || /halaman error internal|tanpa respons HTTP utama/i.test(error.message);

      if (page && blockInitialAssets && !page.isClosed()) {
        await page.setRequestInterception(false).catch(() => {});
        page.off('request', blockInitialAssets);
      }
      if (browser) await browser.close().catch(() => {});

      if (!isRetryable || attempt === maxAttempts) {
        throw new Error(`Navigasi ke NetMirror gagal setelah ${attempt} percobaan: ${error.message}`);
      }

      console.log(`   ⚠️ Navigasi gagal (${error.message}). Menutup browser dan mencoba session proxy baru...`);
    }
  }

  throw new Error(`Navigasi ke NetMirror gagal: ${lastError?.message || 'alasan tidak diketahui'}`);
}

async function clickVerificationAd(page, browser, proxy) {
  const candidates = await page.$$('.open-support, .checker');
  let button = null;
  let buttonInfo = null;

  for (const candidate of candidates) {
    const info = await candidate.evaluate((element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        className: element.className || '',
        tagName: element.tagName,
        visible: style.display !== 'none'
          && style.visibility !== 'hidden'
          && Number(style.opacity || 1) > 0
          && rect.width > 0
          && rect.height > 0,
      };
    }).catch(() => null);

    if (info?.visible) {
      button = candidate;
      buttonInfo = info;
      break;
    }
  }

  if (!button) {
    throw new Error(`Tombol verifikasi iklan terlihat tidak ditemukan (${candidates.length} kandidat ada di DOM).`);
  }

  console.log(`   -> Tombol aktif: <${buttonInfo.tagName.toLowerCase()}> class="${buttonInfo.className}"`);
  await page.bringToFront();
  await button.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'center' }));
  await new Promise(resolve => setTimeout(resolve, 500));

  const popupTargetPromise = browser.waitForTarget(
    target => target.type() === 'page' && target.opener() === page.target(),
    { timeout: 15000 }
  ).catch(() => null);

  const box = await button.boundingBox();
  if (!box) {
    throw new Error('Tombol verifikasi kehilangan area klik sebelum interaksi dilakukan.');
  }

  // Gunakan pointer event nyata dari DevTools, bukan HTMLElement.click().
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
  await page.mouse.down();
  await new Promise(resolve => setTimeout(resolve, 180));
  await page.mouse.up();

  const popupTarget = await popupTargetPromise;
  if (!popupTarget) {
    console.log('   ⚠️ Klik tidak membuat popup baru; melanjutkan karena provider dapat memakai redirect/iframe.');
    return { page: null, host: null, intermediate: false };
  }

  const adPage = await popupTarget.page();
  if (!adPage) {
    console.log('   ⚠️ Target iklan terbuat tetapi halaman popup tidak dapat diakses.');
    return { page: null, host: null, intermediate: false };
  }

  if (proxy.auth) await adPage.authenticate(proxy.auth).catch(() => {});
  await adPage.setUserAgent(MOBILE_UA).catch(() => {});
  await adPage.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true }).catch(() => {});

  // Beri kesempatan pada short-link iklan untuk menyelesaikan redirect dan
  // callback server-side. Popup sengaja tidak ditutup selama polling.
  await adPage.waitForFunction(() => location.href !== 'about:blank', { timeout: 15000 }).catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 8000));

  let adUrl = adPage.url();
  if (adUrl.startsWith('chrome-error://')) {
    console.log('   ⚠️ Popup iklan mengalami error jaringan; mencoba reload satu kali...');
    await adPage.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    adUrl = adPage.url();
  }

  let adHost = adUrl;
  try {
    adHost = new URL(adUrl).hostname || adUrl;
  } catch (e) {}
  console.log(`   -> Popup iklan aktif pada host: ${adHost}`);

  const intermediate = /(^|\.)userver\.net52\.cc$/i.test(adHost);
  if (intermediate) {
    console.log('   ⚠️ Popup masih berhenti di endpoint perantara userver; callback akan diuji sebentar sebelum retry.');
  }

  return { page: adPage, host: adHost, intermediate };
}

async function harvestSessionAttempt(origin, sessionAttempt) {
  console.log('\n[2/5] 🤖 Menjalankan Headless Browser untuk verifikasi iklan...');
  if (sessionAttempt > 1) {
    console.log(`   -> Mengulang verifikasi dengan browser dan session proxy baru (${sessionAttempt}/2)...`);
  }
  const puppeteer = resolvePuppeteer();
  const { browser, page, response, proxy } = await openNetMirrorPage(puppeteer, origin);
  let verifiedCookies = null;

  try {
    const pageTitle = await page.title().catch(() => '');
    const currentUrl = page.url();
    const httpStatus = response ? response.status() : 'unknown';
    console.log(`   -> Judul Halaman: "${pageTitle}" | URL: ${currentUrl} | HTTP Status: ${httpStatus}`);

    // Tunggu selektor body[data-addhash]
    await page.waitForFunction(() => {
      return document.body && document.body.hasAttribute('data-addhash');
    }, { timeout: 15000 }).catch(() => {});

    const initialHash = await page.evaluate(() => {
      return document.body.getAttribute('data-addhash') || null;
    });

    if (!initialHash) {
      const bodySnippet = await page.evaluate(() => document.body?.innerHTML?.slice(0, 300) || 'empty');
      console.log(`   ⚠️ data-addhash tidak ditemukan! Snippet body: ${bodySnippet.replace(/\s+/g, ' ')}`);
      throw new Error(`Gagal membaca data-addhash. Kemungkinan Cloudflare Challenge ("${pageTitle}") atau halaman berubah.`);
    }

    console.log(`   -> Status data-addhash: ${initialHash.slice(0, 45)}...`);
    console.log(`   -> Format klasifikasi NetMirror: ${describeNetMirrorIpMarker(initialHash)}`);

    console.log('\n[3/5] ⏳ Melakukan polling verifikasi ke /mobile/verify2.php...');
    let isAllDone = false;
    const maxAdAttempts = 3;

    adAttempts:
    for (let adAttempt = 1; adAttempt <= maxAdAttempts; adAttempt++) {
      console.log(`\n   -> Percobaan popup iklan ${adAttempt}/${maxAdAttempts}...`);
      const adResult = await clickVerificationAd(page, browser, proxy);
      console.log(`   -> Tombol iklan ditekan${adResult.page ? ' dan popup berhasil dibuka' : ''}. Menunggu callback verifikasi...`);

      // Endpoint userver yang tidak meneruskan redirect biasanya tidak akan
      // berhasil walau ditunggu lama. Beri 12 detik; landing eksternal diberi 24 detik.
      const pollLimitSeconds = adResult.intermediate ? 12 : 24;

      for (let sec = 2; sec <= pollLimitSeconds; sec += 2) {
        await new Promise(r => setTimeout(r, 2000));

        let pollResult = null;
        let navReloadDetected = false;

        try {
          pollResult = await page.evaluate(async (hash) => {
            try {
              const res = await fetch('/mobile/verify2.php', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                  'X-Requested-With': 'XMLHttpRequest',
                },
                body: 'verify=' + encodeURIComponent(hash),
              });
              return await res.json();
            } catch (e) {
              return { error: e.message };
            }
          }, initialHash);
        } catch (evalErr) {
          // Ketika verifikasi sukses, script NetMirror otomatis menjalankan location.reload().
          if (evalErr.message.includes('Execution context was destroyed') || evalErr.message.includes('navigating')) {
            console.log(`\n   ℹ️ Terdeteksi auto-reload halaman dari NetMirror (indikasi verifikasi berhasil).`);
            navReloadDetected = true;
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
          } else {
            console.log(`\n   ⚠️ Polling eval info: ${evalErr.message.split('\n')[0]}`);
          }
        }

        const checkCookies = await page.cookies().catch(() => []);
        const hasSessionCookie = checkCookies.some(c => c.name === 't_hash_t' || c.name === 't_hash');
        const statusText = pollResult?.statusup || pollResult?.error || (navReloadDetected ? 'Auto-Reloading Page' : 'Waiting response');
        console.log(`   ⏱️ [Iklan ${adAttempt}/${maxAdAttempts} | ${sec}s] Status verifikasi: ${statusText}`);

        if (navReloadDetected || pollResult?.statusup === 'All Done' || hasSessionCookie) {
          console.log(`\n   🎉 VERIFIKASI BERHASIL pada percobaan iklan ${adAttempt}!`);
          isAllDone = true;

          if (!navReloadDetected) {
            console.log('   -> Me-reload halaman untuk finalisasi cookie...');
            await page.reload({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
          }

          console.log('   -> Memanggil p.php untuk sinkronisasi token...');
          await page.evaluate(async () => {
            try {
              await fetch('/mobile/p.php', { method: 'POST' });
            } catch (e) {}
          }).catch(() => {});
          await new Promise(r => setTimeout(r, 1000));
          break adAttempts;
        }
      }

      if (adResult.page && !adResult.page.isClosed()) {
        await adResult.page.close().catch(() => {});
      }

      if (adAttempt < maxAdAttempts) {
        console.log(`   ⚠️ Callback iklan ${adAttempt} tidak diterima${adResult.host ? ` (host: ${adResult.host})` : ''}. Mencoba iklan baru...`);
        await page.bringToFront().catch(() => {});
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    if (!isAllDone) {
      console.log('\n   ⚠️ Polling tidak mencapai "All Done", mencoba membaca cookie yang tersedia...');
    }

    // Ekstrak semua cookies via CDP session & page.cookies()
    const client = await page.target().createCDPSession();
    const allCookiesObj = await client.send('Network.getAllCookies').catch(() => ({ cookies: [] }));
    const pageCookies = await page.cookies().catch(() => []);
    const mergedCookies = [...(allCookiesObj.cookies || []), ...pageCookies];

    // Dedup cookies by name
    const cookieMap = new Map();
    for (const c of mergedCookies) {
      if (!cookieMap.has(c.name)) cookieMap.set(c.name, c);
    }
    const finalCookies = Array.from(cookieMap.values());

    const tHashTCookie = finalCookies.find(c => c.name === 't_hash_t');
    const tHashCookie = finalCookies.find(c => c.name === 't_hash');
    const addHashCookie = finalCookies.find(c => c.name === 'addhash');

    const primaryToken = tHashTCookie?.value || tHashCookie?.value;

    if (!primaryToken) {
      console.log('   Daftar cookie yang ditemukan:', finalCookies.map(c => c.name).join(', '));
      const error = new Error('Verifikasi gagal: Cookie t_hash_t maupun t_hash tidak ditemukan setelah semua percobaan iklan.');
      error.code = 'AD_VERIFICATION_FAILED';
      throw error;
    }

    // Uji coba probe pencarian langsung di browser sebelum ditutup
    console.log('\n   -> 🔍 Menguji probe pencarian langsung di browser...');
    let browserProbePassed = false;
    try {
      const bProbe = await page.evaluate(async (tm) => {
        try {
          const res = await fetch(`/mobile/search.php?s=Avatar&tm=${tm}`, {
            headers: { 'Accept': 'application/json, text/plain, */*' }
          });
          return await res.json();
        } catch (e) {
          return { error: e.message };
        }
      }, Math.floor(Date.now() / 1000));

      const bStatus = bProbe?.status;
      const bHead = bProbe?.head || '';
      const bCount = bProbe?.searchResult?.length || bProbe?.search?.length || 0;
      console.log(`   -> Hasil probe browser: status="${bStatus}", count=${bCount}, head="${bHead}"`);

      if (bStatus === 'y' && !/top\s+search/i.test(bHead)) {
        browserProbePassed = true;
        const title = bProbe.searchResult?.[0]?.t || 'Avatar';
        console.log(`   -> ✅ Sesi TERBUKTI AKTIF & VALID DI BROWSER! Target: "${title}"`);
      }
    } catch (e) {}

    verifiedCookies = {
      t_hash_t: tHashTCookie?.value || primaryToken,
      t_hash: tHashCookie?.value || primaryToken,
      addhash: addHashCookie?.value || initialHash,
      allCookies: finalCookies,
      browserProbePassed,
    };

    console.log(`   -> Cookie t_hash  : ${verifiedCookies.t_hash.slice(0, 40)}...`);
    console.log(`   -> Cookie t_hash_t: ${verifiedCookies.t_hash_t.slice(0, 40)}...`);
    console.log(`   -> Cookie addhash : ${verifiedCookies.addhash.slice(0, 40)}...`);

  } finally {
    await browser.close().catch(() => {});
  }

  return verifiedCookies;
}

async function harvestSession(origin) {
  const maxBrowserSessions = 2;
  let lastError = null;

  for (let sessionAttempt = 1; sessionAttempt <= maxBrowserSessions; sessionAttempt++) {
    try {
      return await harvestSessionAttempt(origin, sessionAttempt);
    } catch (error) {
      lastError = error;
      if (error.code !== 'AD_VERIFICATION_FAILED' || sessionAttempt === maxBrowserSessions) {
        throw error;
      }

      console.log('\n   ⚠️ Semua popup pada browser ini gagal. Mengganti browser dan session proxy...');
    }
  }

  throw lastError || new Error('Verifikasi iklan gagal tanpa detail tambahan.');
}

async function validateSession(origin, cookies) {
  console.log('\n[4/5] 🔍 Menguji validitas sesi dengan probe katalog (search.php)...');
  const cookieParts = [];
  if (cookies.t_hash) cookieParts.push(`t_hash=${cookies.t_hash}`);
  if (cookies.t_hash_t) cookieParts.push(`t_hash_t=${cookies.t_hash_t}`);
  if (cookies.addhash) cookieParts.push(`addhash=${cookies.addhash}`);
  cookieParts.push('ott=nf', 'hd=on');
  const cookieHeader = cookieParts.join('; ');

  const probeUrl = `${origin}/mobile/search.php?s=Avatar&tm=${Math.floor(Date.now() / 1000)}`;

  let data = null;

  // Jika proxy aktif, gunakan curl untuk memastikan request melalui residential proxy dan bypass TLS
  if (activeProxyUrl) {
    try {
      const curlBin = process.platform === 'win32' ? 'curl.exe' : 'curl';
      const args = [
        '-sL',
        '--max-time', '15',
        probeUrl,
        '-x', activeProxyUrl,
        '-H', `User-Agent: ${MOBILE_UA}`,
        '-H', `Cookie: ${cookieHeader}`,
        '-H', `Referer: ${origin}/mobile/`,
        '--compressed'
      ];
      const res = spawnSync(curlBin, args, { encoding: 'utf-8' });
      if (res.stdout) {
        data = JSON.parse(res.stdout);
      }
    } catch (e) {}
  }

  // Fallback ke native fetch jika curl tidak mengembalikan data
  if (!data) {
    const res = await fetch(probeUrl, {
      headers: {
        'User-Agent': MOBILE_UA,
        'Cookie': cookieHeader,
        'Referer': `${origin}/mobile/`,
      },
    });
    data = await res.json().catch(() => null);
  }

  const status = data?.status;
  const isTopSearch = /top\s+search/i.test(data?.head || '');
  const count = data?.searchResult?.length || data?.search?.length || 0;

  console.log(`   -> Status respons: ${status} (Hasil: ${count} judul)`);
  if (data?.head) console.log(`   -> Header katalog: "${data.head}"`);

  const isSuccess = (status === 'y' && !isTopSearch && count > 0) || cookies.browserProbePassed;

  if (!isSuccess) {
    throw new Error(`Uji coba pencarian GAGAL! Respons search: status="${status}", head="${data?.head || 'unknown'}", count=${count}. Token tidak akan disimpan karena belum lolos uji.`);
  }

  const title = data?.searchResult?.[0]?.t || data?.search?.[0]?.t || 'Avatar';
  console.log(`   -> ✅ UJI COBA SUKSES! Sesi TERBUKTI AKTIF & VALID! Target: "${title}"`);
  return true;
}

function saveTokenJson(origin, session) {
  console.log('\n[5/5] 📁 Menyimpan token ke token.json (bebas Redis!)...');
  const tokenFilePath = path.join(__dirname, '../token.json');

  const cookieParts = [];
  if (session.t_hash) cookieParts.push(`t_hash=${session.t_hash}`);
  if (session.t_hash_t) cookieParts.push(`t_hash_t=${session.t_hash_t}`);
  if (session.addhash) cookieParts.push(`addhash=${session.addhash}`);
  cookieParts.push('ott=nf', 'hd=on');
  const fullCookie = cookieParts.join('; ');

  const data = {
    status: 'ok',
    origin,
    t_hash: session.t_hash || '',
    t_hash_t: session.t_hash_t || '',
    addhash: session.addhash || '',
    cookie: fullCookie,
    updated_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString(),
  };

  fs.writeFileSync(tokenFilePath, JSON.stringify(data, null, 2), 'utf8');
  console.log(`   -> ✅ Berhasil menulis ${tokenFilePath}`);
}

async function syncToRedisIfAvailable(sessionCookieString) {
  if (!REDIS_URL || !REDIS_TOKEN) {
    return;
  }
  console.log('   -> 🔄 Melakukan sinkronisasi opsional ke Upstash Redis...');
  const cleanUrl = REDIS_URL.replace(/\/+$/, '');
  const ottModes = ['nf', 'pv', 'hs'];
  const ttlSeconds = 36000; // 10 jam (sesuai interval cron 10 jam)

  for (const ott of ottModes) {
    const redisKey = `wins:nm-mobile:web-session:v1:${ott}`;
    const endpoint = `${cleanUrl}/set/${encodeURIComponent(redisKey)}/${encodeURIComponent(sessionCookieString)}?ex=${ttlSeconds}`;
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
      });
      if (res.ok) {
        console.log(`      ✓ Redis [${ott}] updated`);
      }
    } catch {}
  }
}

async function main() {
  console.log('===========================================================');
  console.log('🌟 NETMIRROR AUTOMATED SESSION HARVESTER (WINS TV)');
  console.log('===========================================================');

  const origin = await discoverDomain();
  const session = await harvestSession(origin);

  console.log('\n🎫 Data Cookie Hasil Verifikasi:');
  console.log(`   t_hash   : ${session.t_hash}`);
  console.log(`   t_hash_t : ${session.t_hash_t}`);
  console.log(`   addhash  : ${session.addhash}`);

  await validateSession(origin, session);

  if (IS_TEST_ONLY) {
    console.log('\nMode test-only: Melewati penyimpanan file.');
  } else {
    saveTokenJson(origin, session);
    await syncToRedisIfAvailable(session.cookie);
  }

  console.log('\n===========================================================');
  console.log('🎉 HARVEST BERHASIL 100%! TOKEN SIAP DIGUNAKAN.');
  console.log('===========================================================');
}

main().catch(err => {
  console.error('\n❌ ERROR FATAL PADA HARVESTER:', err.message);
  process.exit(1);
});
