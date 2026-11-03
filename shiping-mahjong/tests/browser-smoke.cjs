const assert=require('node:assert/strict');
const {chromium}=require('playwright');

(async()=>{
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:900}});
    const pageErrors=[];
    page.on('pageerror',error=>pageErrors.push(error.message));
    await page.goto('http://127.0.0.1:8080/',{waitUntil:'networkidle'});
    await page.locator('#hand-tiles .tile-face.playable').first().waitFor({timeout:10000});
    const initial=await page.locator('#hand-tiles .tile-face').count();
    assert.equal(initial,14,'庄家开局应有14张手牌');
    await page.locator('#hand-tiles .tile-face.playable').first().click();
    await page.waitForFunction(()=>document.querySelectorAll('#hand-tiles .tile-face').length===13,{timeout:5000});
    const afterDiscard=await page.locator('#hand-tiles .tile-face').count();
    assert.equal(afterDiscard,13,'点击一张牌后手牌应减少到13张');
    await page.locator('#new-game').click();
    await page.waitForFunction(()=>document.querySelectorAll('#hand-tiles .tile-face').length===14,{timeout:5000});
    assert.deepEqual(pageErrors,[],'页面执行期间不应出现未捕获的JavaScript异常');
    console.log('Browser smoke passed: page loaded, 14-card deal, discard click, new game, no page errors.');
  }finally{
    await browser.close();
  }
})().catch(error=>{console.error(error);process.exit(1)});
