// 1. Create right-click menu
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "lookupWordMenu",
    title: "Look up '%s'", 
    contexts: ["selection"]
  });
});

// 2. Handle right-click click by sending the word to the webpage content script
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "lookupWordMenu" && info.selectionText) {
    chrome.tabs.sendMessage(tab.id, { 
      action: "showTooltipLoading", 
      word: info.selectionText.trim() 
    });

    // Fetch the word data
    fetchWordData(info.selectionText.trim(), (response) => {
      chrome.tabs.sendMessage(tab.id, { 
        action: "showTooltipData", 
        data: response 
      });
    });
  }
});

// 3. Keep standard popup support if user clicks the extension toolbar icon
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'fetchWord') {
    fetchWordData(request.word, sendResponse);
    return true; 
  }
  
  
  if (request.action === "getEtym") {
    const targetWord = request.targetWord;
    // 调用上面封装好的fetchEtymData
    fetchEtymData(targetWord)
      .then(result => {
        sendResponse(result);
      })
      .catch(err => {
        sendResponse({
          success: false,
          msg: err.message
        });
      });
    // 异步请求必须return true，维持sendResponse通道
    return true;
  }
  
  
    // Handle Save Request
  if (request.action === "saveWord") {
    chrome.storage.local.get({ savedWords: [] }, (data) => {
      let list = data.savedWords;
      
      // Prevent duplicates based on word title
      const alreadyExists = list.some(item => item.word.toLowerCase() === request.wordData.word.toLowerCase());
      
      if (!alreadyExists) {
        list.push(request.wordData);
        chrome.storage.local.set({ savedWords: list }, () => {
          sendResponse({ success: true, message: `"${request.wordData.word}" saved successfully!` });
        });
      } else {
        sendResponse({ success: false, message: "Word already exists in your list." });
      }
    });
    return true; // Keeps messaging channel open for asynchronous sendResponse
  }

  
 
  
  
});

// Helper function to handle API calls
function fetchWordData(word, callback) {
  const encodedWord = encodeURIComponent(word);
  const apiUrl = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodedWord}`;


  fetch(apiUrl)
    .then(response => {
      if (!response.ok) throw new Error('Word not found');
      return response.json();
    })
    .then(data => {
      const item = data[0];
      const phonetics = item.phonetics || [];
      const meanings = item.meanings || [];

      let audioUrl = '';
      for (let p of phonetics) {
        if (p.audio) {
          audioUrl = p.audio;
          break;
        }
      }

      let definitionsList = [];
      meanings.forEach(m => {
        m.definitions.slice(0, 2).forEach(d => { // limit to top 2 definitions for tooltips
          definitionsList.push({
            partOfSpeech: m.partOfSpeech,
            definition: d.definition
          });
        });
      });

      callback({
        success: true,
        word: item.word,
        phonetic: item.phonetic || 'N/A',
        audio: audioUrl,
        definitions: definitionsList
      });
    })
    .catch(error => {
      callback({ success: false, error: error.message });
    });
}

// 独立方法：专门请求Etymonline词源，对标你的fetchWordData
async function fetchEtymData(word) {
  const url = `https://www.etymonline.com/search?q=${encodeURIComponent(word)}`;
  const res = await fetch(url);
  const html = await res.text();
   /*console.log(url);*/
  /*
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");

  const title = doc.querySelector(".word__name--TTbAA")?.innerText || word;
  const content = doc.querySelector(".word__defination--2q7ZH")?.innerText;
  
  if (!content) {
    throw new Error("Not found on Etymonline");
  }
  */
  return {
    success: true,
    rawHtml:html 
  };
}