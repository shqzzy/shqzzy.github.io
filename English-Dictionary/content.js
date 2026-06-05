let tooltip = null;
let isDrag = false;
let dragOffsetX = 0;
let dragOffsetY = 0;
// 按下瞬间缓存值
let startMouseX = 0, startMouseY = 0;
let startTipX = 0, startTipY = 0;

// Listen for messages from background.js
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "showTooltipLoading") {
    createTooltip();
    tooltip.innerHTML = `<div style="color: #666;">Searching for "${request.word}"...</div>`;
    positionTooltip();
  } 
  
  else if (request.action === "showTooltipData") {
    if (!tooltip) createTooltip();
    
    const response = request.data;
    if (response && response.success) {
      let definitionsHTML = '';
      response.definitions.forEach(d => {
        definitionsHTML += `
          <div style="margin-top: 5px; border-bottom: 1px solid #eee; padding-bottom: 5px;">
            <strong style="color: #1967d2; font-size: 11px;">${d.partOfSpeech}</strong>
            <p style="margin: 2px 0 0 0; font-size: 13px; color: #333;">${d.definition}</p>
          </div>
        `;
      });


      tooltip.innerHTML = `
        <div id="dragHeader" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px; cursor: move;">
          <h3 style="margin: 0; font-size: 16px; color: #1a73e8;">${response.word}</h3>
		  
		            <button id="ext-save-btn" style="background: #34a853; color: white; border: none; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 12px;"> ➕ </button>

          <button id="ext-close-btn" style="background: none; border: none; cursor: pointer; font-size: 14px; color: #999;">✕</button>
        </div>
        <div style="font-style: italic; color: #666; font-size: 12px; margin-bottom: 8px;">${response.phonetic}</div>
        
        <!-- Button and Link Container -->
        <div style="display: flex; gap: 10px; align-items: center; margin-bottom: 10px;">
          ${response.audio ? `<button id="ext-audio-btn" style="background: #1a73e8; color: white; border: none; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 12px;">🔊 Play</button>` : ''}
          <span id="etymBtn"  style="color:#2b67d9;cursor:pointer;padding:6px 8px;">📚 Etymology</span>
        </div>
		<div id="etymResult" style="margin-top:12px;border-top:1px solid #eee;padding-top:10px;max-height:300px;overflow:auto;"></div>
        <div id="ext-status-msg" style="font-size: 11px; font-weight: bold; margin-bottom: 5px; display: none;"></div>

        <div style="max-height: 150px; overflow-y: auto;">${definitionsHTML}</div>
      `;

      // Add close logic
      document.getElementById('ext-close-btn').onclick = removeTooltip;

      // Add audio logic
      if (response.audio) {
        document.getElementById('ext-audio-btn').onclick = () => {
          new Audio(response.audio).play();
        };
      }
	  
	   // --- NEW: Save Word Logic ---
      document.getElementById('ext-save-btn').onclick = () => {
        const statusMsg = document.getElementById('ext-status-msg');
        
        // Request background script to save the data securely
        chrome.runtime.sendMessage({ 
          action: "saveWord", 
          wordData: {
            word: response.word,
            phonetic: response.phonetic || '',
            definition: response.definitions[0]?.definition || '' // Saves primary meaning
          } 
        }, (res) => {
          statusMsg.style.display = "block";
          statusMsg.style.color = res.success ? "#24b24b" : "#d93025";
          statusMsg.innerText = res.message;
        });
      };
	  
	  
	  // ========== 关键修改1：在tooltip内容渲染后绑定拖拽事件 ==========
	  bindDragEvents();

	  
	  // 在content.js的showTooltipData分支中，添加etymBtn点击逻辑
document.getElementById('etymBtn').addEventListener('click',async ()=>{
	
  const etymResultBox = document.getElementById('etymResult');
  const word = response.word; // 替换成你存单词的变量，如selectedWord
  etymResultBox.textContent = "Loading Etymology...";

  // 向background发送消息，委托拉取词源
  chrome.runtime.sendMessage({
    action:"getEtym",
    targetWord:word
  },(res)=>{
    if(res && res.success){
		
		const parser = new DOMParser();
      const doc = parser.parseFromString(res.rawHtml,"text/html");

      
	  let mainSec = doc.querySelector('section[class*="prose lg:prose-lg"]');
		// 匹配不到再 fallback 原来第三个section
		if (!mainSec) {
		  const allSec = doc.querySelectorAll('section');
		  mainSec = allSec[2];
		}

      if(!mainSec){
        etymResultBox.textContent = "No etymology found 1";
        return;
      }

      // ========== 批量处理所有a标签 ==========
      const baseDomain = "https://www.etymonline.com";
      const allA = mainSec.querySelectorAll('a[href]');
      allA.forEach(a=>{
        let href = a.getAttribute('href');
        // 补全相对链接域名
        if(href.startsWith('/')){
          a.href = baseDomain + href;
        }else if(!href.startsWith('http')){
          // 非常规锚点/协议链接不动
        }
        // 新标签打开 + 安全属性
        a.target = "_blank";
        a.rel = "noopener noreferrer";
      })
	  
	  
      // 单词+词性
      const titleEl = doc.querySelector('span[class*="pl-2 text-battleship-gray font-serif"]');

      

      const title = titleEl?.innerText.trim() || word;
      const htmlContent = mainSec.innerHTML;


      if(htmlContent){
        etymResultBox.innerHTML = `<strong>${word} ${title}</strong><div style="margin-top:6px;white-space:pre-line;">${htmlContent}</div> <div><a href="https://www.etymonline.com/word/${word}" target="_black"><strong>Related entries & more</strong></a>`
      }else{
        etymResultBox.textContent = "No etymology found 1";
      }
       
    }else{
      etymResultBox.textContent = res.msg || "No etymology found 2";
    }
  })
})

	  
    } else {
      tooltip.innerHTML = `
        <div style="display: flex; justify-content: space-between;">
          <span style="color: #d93025;">Word not found.</span>
          <button id="ext-close-btn" style="background: none; border: none; cursor: pointer;">✕</button>
        </div>`;
      document.getElementById('ext-close-btn').onclick = removeTooltip;
    }
    positionTooltip();
  }
});

function createTooltip() {
  removeTooltip(); // Remove old one if exists
  tooltip = document.createElement('div');
  tooltip.id = "en-word-lookup-tooltip";
  
  // Style the floating box
  Object.assign(tooltip.style, {
    position: 'fixed',
    backgroundColor: 'white',
    border: '1px solid #ccc',
    borderRadius: '8px',
    boxShadow: '0 4px 15px rgba(0,0,0,0.2)',
    padding: '12px',
    zIndex: '2147483647', // ensure it stays on top of everything
    width: '280px',
    fontFamily: 'Arial, sans-serif',
    textAlign: 'left',
    lineHeight: '1.4',
	 opacity: '0',
  transition: 'opacity 0.2s ease'
  });
  
  document.body.appendChild(tooltip);
  
  setTimeout(() => {
  tooltip.style.opacity = '1';
}, 10);
  // Click outside to close tooltip
  
  /*
	  // 拖拽绑定
	const dragHeader = document.getElementById('dragHeader');
	if(dragHeader){
	  dragHeader.style.cursor = 'move';
	  dragHeader.onmousedown = function(e){
		isDrag = true;
		//【关键：只按下时一次性取值，拖动全程不再读取rect】
		const tipRect = tooltip.getBoundingClientRect();
		startTipX = tipRect.left;
		startTipY = tipRect.top;
		startMouseX = e.clientX;
		startMouseY = e.clientY;

		dragHeader.style.cursor = 'grabbing';
		// 只在标题栏阻止选中，下方内容不影响选字
		e.preventDefault();
	  }
	}

	// 移动逻辑固定计算公式
	document.onmousemove = function(e){
	  if(!isDrag || !tooltip) return;
	  // 固定公式：原始弹窗位置 + 鼠标移动差值
	  const newLeft = startTipX + (e.clientX - startMouseX);
	  const newTop = startTipY + (e.clientY - startMouseY);
	  tooltip.style.left = newLeft + 'px';
	  tooltip.style.top = newTop + 'px';
	}

	document.onmouseup = function(){
	  isDrag = false;
	  const dragHeader = document.getElementById('dragHeader');
	  if(dragHeader) dragHeader.style.cursor = 'move';
	}
  
  */
  
  
  
  
  
  
  document.removeEventListener('click', outsideClickCheck);
  
  document.addEventListener('click', outsideClickCheck);
}

function positionTooltip() {
  const selection = window.getSelection();
  if (selection.rangeCount > 0) {
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
  
	 // 基础定位
  let top = rect.bottom + 10;
  let left = rect.left;
  
  // 右边界判断：tooltip超出屏幕则左对齐
  if (left + 280 > viewportWidth) { // 280是tooltip宽度
    left = viewportWidth - 290; // 留10px边距
  }
  
  // 下边界判断：超出则显示在选中文本上方
  if (top + 300 > viewportHeight) { // 300是tooltip预估高度
    top = rect.top - 310; // 留10px边距
  }
  
  tooltip.style.top = `${top}px`;
  tooltip.style.left = `${left}px`;
	
	/*  disabled this position on 06/04/2026 10:35
    // Position floating menu right underneath the selected text
    tooltip.style.top = `${rect.bottom + 10}px`;
    tooltip.style.left = `${rect.left}px`;
	*/
	
  }
}

// ========== 新增：独立的拖拽事件绑定函数 ==========
function bindDragEvents() {
  const dragHeader = document.getElementById('dragHeader');
  if (!dragHeader || !tooltip) return;

  dragHeader.style.cursor = 'move';
  dragHeader.onmousedown = function(e) {
    isDrag = true;
    //【关键：只按下时一次性取值，拖动全程不再读取rect】
    const tipRect = tooltip.getBoundingClientRect();
    startTipX = tipRect.left;
    startTipY = tipRect.top;
    startMouseX = e.clientX;
    startMouseY = e.clientY;

    dragHeader.style.cursor = 'grabbing';
    // 只在标题栏阻止选中，下方内容不影响选字
    e.preventDefault();
  }

  // 移动逻辑固定计算公式
  document.onmousemove = function(e) {
    if(!isDrag || !tooltip) return;
    // 固定公式：原始弹窗位置 + 鼠标移动差值
    const newLeft = startTipX + (e.clientX - startMouseX);
    const newTop = startTipY + (e.clientY - startMouseY);
    tooltip.style.left = newLeft + 'px';
    tooltip.style.top = newTop + 'px';
  }

  document.onmouseup = function() {
    isDrag = false;
    if (dragHeader) dragHeader.style.cursor = 'move';
  }
}


function removeTooltip() {
  if (tooltip) {
    tooltip.remove();
    tooltip = null;
    document.removeEventListener('click', outsideClickCheck);
  }
}

function outsideClickCheck(e) {
  if (tooltip && !tooltip.contains(e.target)) {
    removeTooltip();
  }
}


