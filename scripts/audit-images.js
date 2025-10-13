#!/usr/bin/env node
/*
 Heuristic image-context audit using Playwright.
 - Serves repo locally
 - Visits each *.html page
 - For each major heading (h2/h3), finds a nearby image in the same container
 - Compares heading keywords against image alt/src for contextual match
 - Reports mismatches and duplicates
*/

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { chromium } = require('playwright');

const ROOT = process.cwd();
const PORT = 5080;

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
};

function serve() {
  const server = http.createServer(async (req, res) => {
    try {
      let reqPath = decodeURIComponent(new URL(req.url, `http://localhost:${PORT}`).pathname);
      if (reqPath === '/') reqPath = '/index.html';
      const filePath = path.join(ROOT, reqPath);
      const ext = path.extname(filePath).toLowerCase();
      const ct = contentTypes[ext] || 'application/octet-stream';
      const data = await fsp.readFile(filePath);
      res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'no-cache' });
      res.end(data);
    } catch (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  });
  return new Promise((resolve) => server.listen(PORT, () => resolve(server)));
}

function extractKeywords(text) {
  const base = (text || '').toLowerCase();
  const cleaned = base.replace(/[^a-z0-9\s/&+-]/g, ' ');
  const words = cleaned.split(/\s+/).filter(Boolean);
  const stop = new Set(['the','and','of','our','your','to','for','as','a','an','in','on','by','with','&','-','services','service','solution','solutions','features','frequently','asked','question']);
  const stems = words.filter(w => !stop.has(w));
  return Array.from(new Set(stems));
}

const synonymMap = {
  backup: ['backup','backups','recovery','restore','restore','dr','disaster','datacenter','server','rack','storage'],
  cloud: ['cloud','migration','infrastructure','aws','azure','gcp','kubernetes','cluster','server'],
  support: ['support','helpdesk','service desk','help desk','24/7','24x7','headset','call center','support center'],
  monitoring: ['monitoring','alerts','alerting','dashboard','metrics','observability','uptime'],
  architecture: ['architecture','design','reference','diagram','pattern'],
  consulting: ['consulting','strategy','roadmap','advisory','assessment'],
  crm: ['crm','customer','sales','pipeline','hubspot','salesforce'],
  security: ['security','secure','cyber','iso','soc','compliance','firewall','threat','protection'],
  network: ['network','lan','wan','sd-wan','switch','router'],
  collaboration: ['collaboration','collaborating','team','teamwork','cooperation'],
  scalable: ['scalable','scale','scalability','growing','growth']
};

function expandKeywords(keywords) {
  const expanded = new Set(keywords);
  for (const kw of keywords) {
    if (synonymMap[kw]) synonymMap[kw].forEach(x => expanded.add(x));
  }
  // Map phrases
  if (keywords.includes('backup') && keywords.includes('recovery')) {
    expanded.add('dr');
  }
  if (keywords.includes('cloud') && keywords.includes('migration')) {
    expanded.add('infrastructure');
  }
  if (keywords.includes('24/7')) {
    expanded.add('24x7');
  }
  return Array.from(expanded);
}

function scoreMatch(alt, src, keywords) {
  const hay = `${(alt||'').toLowerCase()} ${path.basename(src||'').toLowerCase()}`;
  if (!hay.trim()) return { matched: false, matches: [] };
  const matches = [];
  for (const kw of keywords) {
    if (hay.includes(kw)) matches.push(kw);
  }
  return { matched: matches.length > 0, matches };
}

async function auditPage(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const results = await page.evaluate(() => {
    function nearestContainer(el) {
      return el.closest('.feature-item, .services-item, .expertise-item, .what-we-highlighted, .what-we-do-box-1, .what-we-do-box, .why-choose-item, .page-service-single, .page-services, .about-us, .our-features, .our-services, .our-testimonials, .how-it-work, section, div') || el;
    }
    function imageForContainer(container) {
      const imgs = container.querySelectorAll('img');
      if (imgs.length) return imgs[0];
      // fallback: search siblings
      let p = container;
      for (let i=0; i<3 && p; i++) { p = p.parentElement; const cimg = p && p.querySelector('img'); if (cimg) return cimg; }
      return null;
    }
    const headings = Array.from(document.querySelectorAll('h2, h3'));
    const out = [];
    for (const h of headings) {
      const text = h.textContent.trim();
      if (!text) continue;
      const container = nearestContainer(h);
      const img = container ? imageForContainer(container) : null;
      const src = img ? img.getAttribute('src') : null;
      const alt = img ? img.getAttribute('alt') : null;
      // classification hints for better heuristics
      const classes = (container?.className || '').toString().toLowerCase();
      const isDecorative = (!!img && (
        (alt === '' || alt === null) ||
        classes.includes('icon-box') ||
        (src||'').toLowerCase().includes('icon-') ||
        (src||'').toLowerCase().includes('arrow-')
      ));
      const isPerson = classes.includes('team') || classes.includes('author') || classes.includes('testimonial') || classes.includes('member') || classes.includes('profile');
      const isMetric = /\d/.test(text) || /%|24\/7|24x7/i.test(text);
      out.push({ heading: text, imgSrc: src, imgAlt: alt, hints: { isDecorative, isPerson, isMetric, containerClass: classes } });
    }
    return out;
  });
  return results;
}

async function main() {
  const server = await serve();
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const pages = (await fsp.readdir(ROOT))
    .filter(f => f.endsWith('.html'))
    .sort();

  const report = [];

  for (const file of pages) {
    const url = `http://localhost:${PORT}/${file}`;
    const items = await auditPage(page, url);
    // dedupe check on headings per page
    const norm = s => s.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
    const counts = {};
    items.forEach(i => { const k = norm(i.heading); counts[k] = (counts[k]||0)+1; });

    const issues = [];
    for (const it of items) {
      const kws = extractKeywords(it.heading);
      const expanded = expandKeywords(kws);
      let matched = false;
      let matches = [];
      const hasImage = !!it.imgSrc;
      // heuristics: ignore decorative, person/metric headings, and headings without any image
      if (!hasImage || it.hints?.isDecorative || it.hints?.isPerson || it.hints?.isMetric || expanded.length === 0) {
        matched = true;
      } else {
        const res = scoreMatch(it.imgAlt, it.imgSrc, expanded);
        matched = res.matched; matches = res.matches;
      }
      const entry = {
        page: file,
        heading: it.heading,
        imgSrc: it.imgSrc || '',
        imgAlt: it.imgAlt || '',
        keywords: expanded,
        match: matched,
        evidence: matches,
        hints: it.hints || {}
      };
      if (!matched) issues.push(entry);
      report.push(entry);
    }
    // duplicate headings
    Object.entries(counts).forEach(([k,v]) => {
      if (v > 1 && k) {
        report.push({ page: file, type: 'duplicate-heading', key: k, count: v });
      }
    });
  }

  await browser.close();
  server.close();

  const outPath = path.join(ROOT, 'audit-images-report.json');
  await fsp.writeFile(outPath, JSON.stringify(report, null, 2));

  // Print summary
  const mismatches = report.filter(r => r.match === false);
  const duplicates = report.filter(r => r.type === 'duplicate-heading');
  console.log(`Pages scanned: ${new Set(report.map(r=>r.page)).size}`);
  console.log(`Image-context mismatches: ${mismatches.length}`);
  console.log(`Duplicate headings: ${duplicates.length}`);
  const top10 = mismatches.slice(0, 10);
  if (top10.length) {
    console.log('\nSample mismatches:');
    top10.forEach(r => {
      console.log(`- [${r.page}] "${r.heading}" -> img: ${r.imgSrc} alt: "${r.imgAlt}" (keywords: ${r.keywords.join(', ')})`);
    });
  }
}

main().catch(err => { console.error(err); process.exit(1); });
