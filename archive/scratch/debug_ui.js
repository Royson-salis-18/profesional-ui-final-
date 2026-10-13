const puppeteer = require('puppeteer');

(async () => {
  try {
    const browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      headless: "new"
    });
    const page = await browser.newPage();
    
    page.on('console', msg => console.log('BROWSER LOG:', msg.text()));
    page.on('pageerror', error => console.log('BROWSER ERROR:', error.message));
    
    await page.setViewport({ width: 1280, height: 800 });
    console.log('Navigating to http://localhost:5173...');
    await page.goto('http://localhost:5173', { waitUntil: 'networkidle0', timeout: 15000 });
    
    const html = await page.evaluate(() => document.body.innerHTML);
    console.log('HTML SNAPSHOT (length):', html.length);
    if (html.includes('TopBar') || html.includes('ADD PROJECT')) {
      console.log('TopBar is in the DOM!');
    } else {
      console.log('TopBar is NOT in the DOM!');
    }
    
    await page.screenshot({ path: '/home/royson/Documents/projects/microservice-mapper/scratch/ui_screenshot.png' });
    console.log('Screenshot saved.');
    
    await browser.close();
  } catch (err) {
    console.error('Script failed:', err);
  }
})();
