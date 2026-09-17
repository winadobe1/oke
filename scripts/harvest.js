/**
 * NetMirror Automated Session Harvester for Wins TV
 * 
 * Flow:
 * 1. Discover active NetMirror domain via bootstrap pool (check.php).
 * 2. Launch headless browser (Puppeteer) with mobile viewport & user agent.
 * 3. Open /mobile/home?app=1 and trigger ad verification.
 * 4. Wait for background verification to reach "All Done" (~25-35s).
 * 5. Extract verified cookies (t_hash_t + addhash).
 * 6. Validate session with a test search probe (assert status: "y").
 * 7. Write token.json directly to repository (Zero-Redis dependency!).
 * 8. Optional: Sync to Redis if credentials are provided.
 */

const fs = require('fs');
const path = require('path');

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
    try {
      return require('puppeteer-core');
    } catch (e2) {
      const scratchPuppeteer = path.join(
        process.env.USERPROFILE || 'C:\\Users\\erwin',
        '.gemini\\antigravity-ide\\brain\\7e30b8c0-52bc-4955-b16b-d07439b5aa54\\scratch\\node_modules\\puppeteer-core'
      );
      if (fs.existsSync(scratchPuppeteer)) {
        return require(scratchPuppeteer);
      }
      throw new Error('Puppeteer tidak ditemukan. Jalankan: npm install');
    }
  }
}

function getChromePath() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  const defaultPaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ];
  for (const p of defaultPaths) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

async function harvestSession(origin) {
  console.log('\n[2/5] 🤖 Menjalankan Headless Browser untuk verifikasi iklan...');
  const puppeteer = resolvePuppeteer();
  const chromePath = getChromePath();

  const launchOpts = {
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-web-security',
      '--disable-blink-features=AutomationControlled',
      '--window-size=390,844',
      '--blink-settings=imagesEnabled=true',
    ],
  };
  if (chromePath) {
    launchOpts.executablePath = chromePath;
  }

  const browser = await puppeteer.launch(launchOpts);
  let verifiedCookies = null;

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await page.setUserAgent(MOBILE_UA);

    // Mask webdriver
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    // Pantau tab popup iklan yang dibuka via window.open
    browser.on('targetcreated', async (target) => {
      if (target.type() === 'page') {
        try {
          const adPage = await target.page();
          if (adPage) {
            console.log(`   [Tab Iklan Terbuka] -> ${adPage.url().slice(0, 70)}...`);
            await adPage.setUserAgent(MOBILE_UA);
          }
        } catch (e) {}
      }
    });

    const targetUrl = `${origin}/mobile/home?app=1`;
    console.log(`   -> Membuka: ${targetUrl}`);
    const response = await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 35000 }).catch(async (err) => {
      console.log(`   ⚠️ Peringatan saat navigasi (${err.message}), mencoba lanjut...`);
      return null;
    });

    const pageTitle = await page.title().catch(() => '');
    const currentUrl = page.url();
    const httpStatus = response ? response.status() : 'unknown';
    console.log(`   -> Judul Halaman: "${pageTitle}" | URL: ${currentUrl} | HTTP Status: ${httpStatus}`);

    // Tunggu selektor body[data-addhash]
    await page.waitForFunction(() => {
      return document.body && document.body.hasAttribute('data-addhash');
    }, { timeout: 10000 }).catch(() => {});

    const initialHash = await page.evaluate(() => {
      return document.body.getAttribute('data-addhash') || null;
    });

    if (!initialHash) {
      const bodySnippet = await page.evaluate(() => document.body?.innerHTML?.slice(0, 300) || 'empty');
      console.log(`   ⚠️ data-addhash tidak ditemukan! Snippet body: ${bodySnippet.replace(/\s+/g, ' ')}`);
      throw new Error(`Gagal membaca data-addhash. Kemungkinan Cloudflare Challenge ("${pageTitle}") atau halaman berubah.`);
    }

    console.log(`   -> Status data-addhash: ${initialHash.slice(0, 45)}...`);
    const isDi = initialHash.includes('::di');
    const isSu = initialHash.includes('::su');
    console.log(`   -> Tipe IP terdeteksi oleh NetMirror: ${isDi ? '✅ RESIDENTIAL/DEVICE (::di)' : isSu ? '⚠️ DATACENTER/SERVER (::su)' : 'UNKNOWN'}`);

    // Cari dan klik tombol iklan
    const button = await page.$('.open-support, .checker');
    if (!button) {
      throw new Error('Tombol verifikasi iklan (.open-support / .checker) tidak ditemukan di halaman.');
    }

    console.log('   -> Tombol iklan ditemukan! Memicu klik verifikasi iklan...');
    await button.click();
    console.log('   -> Tombol iklan ditekan. Menunggu proses callback verifikasi (~25-35s)...');

    console.log('\n[3/5] ⏳ Melakukan polling verifikasi ke /mobile/verify2.php...');
    let isAllDone = false;
    const maxPollSeconds = 45;

    for (let sec = 2; sec <= maxPollSeconds; sec += 2) {
      await new Promise(r => setTimeout(r, 2000));

      const pollResult = await page.evaluate(async (hash) => {
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

      const statusText = pollResult?.statusup || pollResult?.error || JSON.stringify(pollResult);
      process.stdout.write(`   ⏱️ [${sec}s] Status verifikasi: ${statusText}\r`);

      if (pollResult && pollResult.statusup === 'All Done') {
        console.log(`\n   ⏱️ [${sec}s] 🎉 VERIFIKASI SUKSES! Status: "All Done"!`);
        isAllDone = true;

        console.log('   -> Me-reload halaman untuk finalisasi cookie...');
        await page.reload({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});

        console.log('   -> Memanggil p.php untuk sinkronisasi token...');
        await page.evaluate(async () => {
          try {
            await fetch('/mobile/p.php');
          } catch (e) {}
        });
        break;
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
      throw new Error('Verifikasi gagal: Cookie t_hash_t maupun t_hash tidak ditemukan.');
    }

    verifiedCookies = {
      t_hash_t: tHashTCookie?.value || primaryToken,
      t_hash: tHashCookie?.value || primaryToken,
      addhash: addHashCookie?.value || initialHash,
      allCookies: finalCookies,
    };

    console.log(`   -> Cookie t_hash_t: ${verifiedCookies.t_hash_t.slice(0, 40)}...`);
    console.log(`   -> Cookie addhash : ${verifiedCookies.addhash.slice(0, 40)}...`);

  } finally {
    await browser.close().catch(() => {});
  }

  return verifiedCookies;
}

async function validateSession(origin, cookies) {
  console.log('\n[4/5] 🔍 Menguji validitas sesi dengan probe katalog (search.php)...');
  const cookieHeader = `t_hash_t=${cookies.t_hash_t}; addhash=${cookies.addhash || ''}; ott=nf; hd=on`;

  const probeUrl = `${origin}/mobile/search.php?s=Avatar&tm=${Math.floor(Date.now() / 1000)}`;
  const res = await fetch(probeUrl, {
    headers: {
      'User-Agent': MOBILE_UA,
      'Cookie': cookieHeader,
      'Referer': `${origin}/mobile/`,
    },
  });

  const data = await res.json().catch(() => null);
  const status = data?.status;
  const isTopSearch = /top\s+search/i.test(data?.head || '');
  const count = data?.searchResult?.length || 0;

  console.log(`   -> Status respons: ${status} (Hasil: ${count} judul)`);
  if (status !== 'y' || isTopSearch) {
    throw new Error(`Validasi sesi gagal! Respons search: status="${status}", head="${data?.head}"`);
  }

  console.log(`   -> ✅ Sesi TERBUKTI AKTIF & VALID! Target judul: "${data.searchResult[0]?.t}"`);
  return true;
}

function saveTokenJson(origin, session) {
  console.log('\n[5/5] 📁 Menyimpan token ke token.json (bebas Redis!)...');
  const tokenFilePath = path.join(__dirname, '../token.json');

  const fullCookie = `t_hash_t=${session.t_hash_t}; addhash=${session.addhash || ''}; ott=nf; hd=on`;

  const data = {
    status: 'ok',
    origin,
    t_hash_t: session.t_hash_t,
    addhash: session.addhash || '',
    cookie: fullCookie,
    updated_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
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
  const ttlSeconds = 7200;

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
  console.log(`   t_hash_t: ${session.t_hash_t}`);
  console.log(`   addhash  : ${session.addhash}`);

  await validateSession(origin, session);

  if (IS_TEST_ONLY) {
    console.log('\nMode test-only: Melewati penyimpanan file.');
  } else {
    saveTokenJson(origin, session);
    const cookieString = `t_hash_t=${session.t_hash_t}; addhash=${session.addhash || ''}`;
    await syncToRedisIfAvailable(cookieString);
  }

  console.log('\n===========================================================');
  console.log('🎉 HARVEST BERHASIL 100%! TOKEN SIAP DIGUNAKAN.');
  console.log('===========================================================');
}

main().catch(err => {
  console.error('\n❌ ERROR FATAL PADA HARVESTER:', err.message);
  process.exit(1);
});
