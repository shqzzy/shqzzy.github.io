document.addEventListener('DOMContentLoaded', () => {
  // Get currently selected text on the webpage
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    chrome.scripting.executeScript(
      {
        target: { tabId: tabs[0].id },
        func: () => window.getSelection().toString().trim()
      },
      (injectionResults) => {
        if (injectionResults && injectionResults[0].result) {
          const selectedWord = injectionResults[0].result;
          lookupWord(selectedWord);
        } else {
          showError();
        }
      }
    );
  });
  
  
  // --- NEW: Attach Click Handler for Exporting Wordlist ---
  const exportBtn = document.getElementById('export-list-btn');
  if (exportBtn) {
    exportBtn.addEventListener('click', exportWordlist);
  }
  
  
  
  
});


// --- UPDATED: Export Wordlist Function as a Spreadsheet (CSV) ---
function exportWordlist() {
  // Fetch words using your storage key
  chrome.storage.local.get({ savedWords: [] }, (data) => {
    if (data.savedWords.length === 0) {
      alert("Your wordlist is empty. Add some words first!");
      return;
    }

    // Define table header columns
    const headers = ["Word", "Phonetic", "Definition"];
    
    // Process rows and safely escape quotes/commas for spreadsheet formats
    const csvRows = [
      headers.join(",") // Row 1: Headers
    ];

    data.savedWords.forEach(item => {
      // Clean values to prevent cell alignment errors in Excel/Sheets
      const word = (item.word || "").replace(/"/g, '""');
      const phonetic = (item.phonetic || "").replace(/"/g, '""');
      const definition = (item.definition || "").replace(/"/g, '""');

      // Wrap values in double quotes so commas within definitions don't break columns
      csvRows.push(`"${word}","${phonetic}","${definition}"`);
    });

    // Combine all rows with line breaks
    const csvContent = csvRows.join("\n");
    
    // Add UTF-8 Byte Order Mark (BOM) so Excel handles phonetic symbols properly
    const blob = new Blob(["\ufeff" + csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);

    // Create a temporary hidden anchor element to force spreadsheet download
    const downloadLink = document.createElement('a');
    downloadLink.href = url;
    downloadLink.download = 'dictionary_wordlist.csv'; // Extension changed to .csv
    
    document.body.appendChild(downloadLink);
    downloadLink.click();
    
    // Clean up memory resources
    document.body.removeChild(downloadLink);
    URL.revokeObjectURL(url);
  });
}




function lookupWord(word) {
  // Send message to background.js to fetch word data
  chrome.runtime.sendMessage({ action: 'fetchWord', word: word }, (response) => {
    document.getElementById('loading').style.display = 'none';
    
    if (response && response.success) {
      document.getElementById('content').style.display = 'block';
      
      document.getElementById('word-title').textContent = response.word;
      document.getElementById('word-phonetic').textContent = response.phonetic;
      
      // Handle Pronunciation
      const audioBtn = document.getElementById('play-audio-btn');
      if (response.audio) {
        audioBtn.disabled = false;
        audioBtn.onclick = () => {
          new Audio(response.audio).play();
        };
      } else {
        audioBtn.textContent = "Audio unavailable";
        audioBtn.disabled = true;
      }

      // Render Definitions
      const container = document.getElementById('definitions-container');
      container.innerHTML = '';
      
      response.definitions.forEach(d => {
        const div = document.createElement('div');
        div.className = 'definition-box';
        div.innerHTML = `
          <span class="part-of-speech">${d.partOfSpeech}</span>
          <p>${d.definition}</p>
          ${d.example !== 'No example available' ? `<div class="example">"${d.example}"</div>` : ''}
        `;
        container.appendChild(div);
      });
    } else {
      showError();
    }
  });
}

function showError() {
  document.getElementById('loading').style.display = 'none';
  document.getElementById('error').style.display = 'block';
}
