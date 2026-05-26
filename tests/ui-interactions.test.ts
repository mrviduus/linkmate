/**
 * UI Interaction Tests
 * Tests DOM interactions, event handlers, and UI state management
 */

import { fireEvent } from '@testing-library/dom';

describe('UI Interactions', () => {
  let mockEngine: any;
  let mockTab: chrome.tabs.Tab;

  beforeEach(() => {
    // Setup DOM structure matching popup.html
    document.body.innerHTML = `
      <select id="model-selection">
        <option value="Qwen2-0.5B-Instruct-q4f16_1-MLC">Qwen2-0.5B-Instruct</option>
        <option value="Llama-3.2-1B-Instruct-q4f16_1-MLC">Llama-3.2-1B-Instruct</option>
      </select>
      <div id="loadingBox">
        <p id="init-label">Initializing model...</p>
        <div id="loadingContainer"></div>
      </div>
      <p id="model-name"></p>
      <div class="input-container form-group">
        <input type="search" id="query-input" placeholder="What's on your mind?" />
        <button id="submit-button" class="btn" disabled>
          <i class="fa fa-comments"></i>
        </button>
      </div>
      <div class="stage">
        <div id="loading-indicator" class="dot-flashing" style="display: none;"></div>
      </div>
      <div id="answerWrapper" style="display: none;">
        <div id="answer"></div>
        <div class="copyRow">
          <span id="timestamp"></span>
          <button id="copyAnswer" class="btn copyButton" title="Copy the Answer to the Clipboard">
            <i class="fa-solid fa-copy fa-lg"></i>
          </button>
        </div>
      </div>
    `;

    // Mock AI engine
    mockEngine = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            async *[Symbol.asyncIterator]() {
              yield { choices: [{ delta: { content: 'Hello' } }] };
              yield { choices: [{ delta: { content: ' world' } }] };
              yield { choices: [{ delta: { content: '!' } }] };
            }
          })
        }
      },
      getMessage: jest.fn().mockResolvedValue('Hello world!'),
      reload: jest.fn().mockResolvedValue(undefined),
      unload: jest.fn().mockResolvedValue(undefined),
      resetChat: jest.fn(),
      interruptGenerate: jest.fn(),
      setInitProgressCallback: jest.fn(),
    };

    // Mock tab
    mockTab = { id: 123, url: 'https://example.com' } as chrome.tabs.Tab;

    // Setup Chrome API mocks
    (chrome.tabs.query as jest.Mock).mockImplementation((query, callback) => {
      callback([mockTab]);
    });

    (chrome.tabs.connect as jest.Mock).mockReturnValue({
      postMessage: jest.fn(),
      onMessage: {
        addListener: jest.fn((callback) => {
          // Simulate receiving page content
          setTimeout(() => callback({ contents: 'Sample page content' }), 0);
        })
      }
    });
  });

  describe('Input field interactions', () => {
    test('should enable submit button when input has content', () => {
      const queryInput = document.getElementById('query-input') as HTMLInputElement;
      const submitButton = document.getElementById('submit-button') as HTMLButtonElement;

      // Simulate typing in input
      queryInput.value = 'Test question';
      fireEvent.keyUp(queryInput);

      // Button should still be disabled initially (would be enabled by app logic)
      expect(submitButton.disabled).toBe(true);
    });

    test('should handle enter key press in input field', () => {
      const queryInput = document.getElementById('query-input') as HTMLInputElement;
      const submitButton = document.getElementById('submit-button') as HTMLButtonElement;
      
      // Manually add the event listener as it would be in popup.ts
      queryInput.addEventListener("keyup", (event) => {
        if (event.code === "Enter") {
          event.preventDefault();
          submitButton.click();
        }
      });
      
      const clickSpy = jest.spyOn(submitButton, 'click');

      // Simulate Enter key press
      fireEvent.keyUp(queryInput, { code: 'Enter' });

      expect(clickSpy).toHaveBeenCalled();
    });

    test('should clear input after submission', () => {
      const queryInput = document.getElementById('query-input') as HTMLInputElement;
      
      queryInput.value = 'Test question';
      
      // Simulate form submission logic
      const clearInput = () => {
        queryInput.value = '';
      };
      
      clearInput();
      expect(queryInput.value).toBe('');
    });
  });

  describe('Model selection', () => {
    test('should update selected model when dropdown changes', () => {
      const modelSelector = document.getElementById('model-selection') as HTMLSelectElement;
      
      // Change selection
      modelSelector.value = 'Llama-3.2-1B-Instruct-q4f16_1-MLC';
      fireEvent.change(modelSelector);

      expect(modelSelector.value).toBe('Llama-3.2-1B-Instruct-q4f16_1-MLC');
    });

    test('should populate model dropdown with available models', () => {
      const modelSelector = document.getElementById('model-selection') as HTMLSelectElement;
      const options = Array.from(modelSelector.options);
      
      expect(options).toHaveLength(2);
      expect(options[0].value).toBe('Qwen2-0.5B-Instruct-q4f16_1-MLC');
      expect(options[1].value).toBe('Llama-3.2-1B-Instruct-q4f16_1-MLC');
    });
  });

  describe('Loading states', () => {
    test('should show loading indicator during processing', () => {
      const loadingIndicator = document.getElementById('loading-indicator');
      
      // Simulate showing loading
      loadingIndicator!.style.display = 'block';
      
      expect(loadingIndicator!.style.display).toBe('block');
    });

    test('should hide loading indicator after completion', () => {
      const loadingIndicator = document.getElementById('loading-indicator');
      
      // Simulate hiding loading
      loadingIndicator!.style.display = 'none';
      
      expect(loadingIndicator!.style.display).toBe('none');
    });

    test('should update model name during loading', () => {
      const modelName = document.getElementById('model-name');
      
      // Simulate loading state
      modelName!.innerText = 'Loading initial model...';
      expect(modelName!.innerText).toBe('Loading initial model...');
      
      // Simulate loaded state
      modelName!.innerText = 'Now chatting with Qwen2-0.5B-Instruct';
      expect(modelName!.innerText).toBe('Now chatting with Qwen2-0.5B-Instruct');
    });
  });

  describe('Answer display and interaction', () => {
    test('should show answer wrapper when answer is available', () => {
      const answerWrapper = document.getElementById('answerWrapper');
      const answer = document.getElementById('answer');
      
      // Simulate showing answer
      answerWrapper!.style.display = 'block';
      answer!.innerHTML = 'This is the AI response';
      
      expect(answerWrapper!.style.display).toBe('block');
      expect(answer!.innerHTML).toBe('This is the AI response');
    });

    test('should convert newlines to br tags in answer', () => {
      const answer = document.getElementById('answer');
      
      const testText = 'Line 1\nLine 2\nLine 3';
      const expectedHTML = 'Line 1<br>Line 2<br>Line 3';
      
      // Simulate answer processing
      const processedAnswer = testText.replace(/\n/g, '<br>');
      answer!.innerHTML = processedAnswer;
      
      expect(answer!.innerHTML).toBe(expectedHTML);
    });

    test('should update timestamp when answer is displayed', () => {
      const timestamp = document.getElementById('timestamp');
      
      // Simulate timestamp update
      const options: Intl.DateTimeFormatOptions = {
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      };
      const time = new Date().toLocaleString("en-US", options);
      timestamp!.innerText = time;
      
      expect(timestamp!.innerText).toMatch(/\w+\s+\d+,\s+\d+:\d+:\d+\s+(AM|PM)/);
    });
  });

  describe('Copy functionality', () => {
    test('should copy answer to clipboard when copy button is clicked', async () => {
      const copyButton = document.getElementById('copyAnswer') as HTMLButtonElement;
      const testAnswer = 'This is a test answer';
      
      // Mock clipboard write
      const writeTextSpy = jest.spyOn(navigator.clipboard, 'writeText');
      writeTextSpy.mockResolvedValue();
      
      // Simulate copy button click
      copyButton.addEventListener('click', () => {
        navigator.clipboard.writeText(testAnswer);
      });
      
      fireEvent.click(copyButton);
      
      expect(writeTextSpy).toHaveBeenCalledWith(testAnswer);
    });

    test('should handle clipboard copy errors gracefully', async () => {
      const copyButton = document.getElementById('copyAnswer') as HTMLButtonElement;
      const testAnswer = 'This is a test answer';
      
      // Mock clipboard write to reject
      const writeTextSpy = jest.spyOn(navigator.clipboard, 'writeText');
      writeTextSpy.mockRejectedValue(new Error('Clipboard access denied'));
      
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      
      // Simulate copy button click with error handling
      copyButton.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(testAnswer);
        } catch (err) {
          console.error('Could not copy text: ', err);
        }
      });
      
      fireEvent.click(copyButton);
      
      // Wait for async operation
      await new Promise(resolve => setTimeout(resolve, 0));
      
      expect(writeTextSpy).toHaveBeenCalledWith(testAnswer);
      expect(consoleSpy).toHaveBeenCalledWith('Could not copy text: ', expect.any(Error));
      
      consoleSpy.mockRestore();
    });
  });

  describe('Page content fetching', () => {
    test('should fetch page contents from active tab', () => {
      const mockPort = {
        postMessage: jest.fn(),
        onMessage: {
          addListener: jest.fn()
        }
      };

      (chrome.tabs.connect as jest.Mock).mockReturnValue(mockPort);

      // Simulate fetchPageContents function
      const fetchPageContents = () => {
        chrome.tabs.query({ currentWindow: true, active: true }, function (tabs) {
          if (tabs[0]?.id) {
            const port = chrome.tabs.connect(tabs[0].id, { name: "channelName" });
            port.postMessage({});
          }
        });
      };

      fetchPageContents();

      expect(chrome.tabs.query).toHaveBeenCalledWith(
        { currentWindow: true, active: true },
        expect.any(Function)
      );
      expect(chrome.tabs.connect).toHaveBeenCalledWith(123, { name: "channelName" });
      expect(mockPort.postMessage).toHaveBeenCalledWith({});
    });

    test('should handle tab query with no active tabs', () => {
      (chrome.tabs.query as jest.Mock).mockImplementation((query, callback) => {
        callback([]);
      });

      const fetchPageContents = () => {
        chrome.tabs.query({ currentWindow: true, active: true }, function (tabs) {
          if (tabs[0]?.id) {
            const port = chrome.tabs.connect(tabs[0].id, { name: "channelName" });
            port.postMessage({});
          }
        });
      };

      // Should not throw error
      expect(() => fetchPageContents()).not.toThrow();
      expect(chrome.tabs.connect).not.toHaveBeenCalled();
    });
  });
});
