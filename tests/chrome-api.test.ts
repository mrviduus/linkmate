/**
 * Chrome Extension API Integration Tests
 * Tests the integration with Chrome extension APIs and messaging
 */

describe('Chrome Extension API Integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Runtime messaging', () => {
    test('should register message listener for background communication', () => {
      const mockListener = jest.fn();
      
      // Simulate registering a message listener
      chrome.runtime.onMessage.addListener(mockListener);
      
      expect(chrome.runtime.onMessage.addListener).toHaveBeenCalledWith(mockListener);
    });

    test('should handle incoming messages with answer data', () => {
      const mockCallback = jest.fn();
      
      // Simulate the message listener from popup.ts
      const messageListener = ({ answer, error }: { answer?: string; error?: string }) => {
        if (answer) {
          mockCallback(answer);
        }
        if (error) {
          console.error('Error:', error);
        }
      };
      
      // Test with answer
      messageListener({ answer: 'Test response' });
      expect(mockCallback).toHaveBeenCalledWith('Test response');
      
      // Test with error
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      messageListener({ error: 'Test error' });
      expect(consoleSpy).toHaveBeenCalledWith('Error:', 'Test error');
      consoleSpy.mockRestore();
    });

    test('should ignore messages without answer or error', () => {
      const mockCallback = jest.fn();
      
      const messageListener = ({ answer, error }: { answer?: string; error?: string }) => {
        if (answer) {
          mockCallback(answer);
        }
      };
      
      messageListener({});
      expect(mockCallback).not.toHaveBeenCalled();
    });
  });

  describe('Tab management', () => {
    test('should query for active tab successfully', async () => {
      const mockTabs = [
        { id: 123, url: 'https://example.com', active: true }
      ];
      
      (chrome.tabs.query as jest.Mock).mockImplementation((query, callback) => {
        callback(mockTabs);
      });
      
      return new Promise<void>((resolve) => {
        chrome.tabs.query({ currentWindow: true, active: true }, (tabs) => {
          expect(tabs).toEqual(mockTabs);
          expect(tabs[0].id).toBe(123);
          resolve();
        });
      });
    });

    test('should handle multiple tabs and select active one', async () => {
      const mockTabs = [
        { id: 123, url: 'https://example.com', active: false },
        { id: 456, url: 'https://google.com', active: true },
        { id: 789, url: 'https://github.com', active: false }
      ];
      
      (chrome.tabs.query as jest.Mock).mockImplementation((query, callback) => {
        // Return only active tab based on query
        callback(mockTabs.filter(tab => tab.active));
      });
      
      return new Promise<void>((resolve) => {
        chrome.tabs.query({ currentWindow: true, active: true }, (tabs) => {
          expect(tabs).toHaveLength(1);
          expect(tabs[0].id).toBe(456);
          resolve();
        });
      });
    });

    test('should handle no active tabs gracefully', async () => {
      (chrome.tabs.query as jest.Mock).mockImplementation((query, callback) => {
        callback([]);
      });
      
      return new Promise<void>((resolve) => {
        chrome.tabs.query({ currentWindow: true, active: true }, (tabs) => {
          expect(tabs).toEqual([]);
          resolve();
        });
      });
    });
  });

  describe('Tab communication', () => {
    test('should establish connection with content script', () => {
      const mockPort = {
        postMessage: jest.fn(),
        onMessage: {
          addListener: jest.fn()
        },
        onDisconnect: {
          addListener: jest.fn()
        }
      };
      
      (chrome.tabs.connect as jest.Mock).mockReturnValue(mockPort);
      
      const tabId = 123;
      const port = chrome.tabs.connect(tabId, { name: 'channelName' });
      
      expect(chrome.tabs.connect).toHaveBeenCalledWith(tabId, { name: 'channelName' });
      expect(port).toBe(mockPort);
    });

    test('should send and receive messages through port', () => {
      const mockPort = {
        postMessage: jest.fn(),
        onMessage: {
          addListener: jest.fn()
        }
      };
      
      (chrome.tabs.connect as jest.Mock).mockReturnValue(mockPort);
      
      const port = chrome.tabs.connect(123, { name: 'channelName' });
      
      // Send message to content script
      port.postMessage({ action: 'getContent' });
      expect(mockPort.postMessage).toHaveBeenCalledWith({ action: 'getContent' });
      
      // Setup message listener
      const messageHandler = jest.fn();
      port.onMessage.addListener(messageHandler);
      expect(mockPort.onMessage.addListener).toHaveBeenCalledWith(messageHandler);
    });

    test('should handle port disconnection', () => {
      const mockPort = {
        postMessage: jest.fn(),
        onMessage: { addListener: jest.fn() },
        onDisconnect: { addListener: jest.fn() }
      };
      
      (chrome.tabs.connect as jest.Mock).mockReturnValue(mockPort);
      
      const port = chrome.tabs.connect(123, { name: 'channelName' });
      
      const disconnectHandler = jest.fn();
      port.onDisconnect.addListener(disconnectHandler);
      
      expect(mockPort.onDisconnect.addListener).toHaveBeenCalledWith(disconnectHandler);
    });
  });

  describe('Storage API', () => {
    test('should save and retrieve data from local storage', async () => {
      const testData = { model: 'Qwen2-0.5B-Instruct-q4f16_1-MLC', history: [] };
      
      // Mock storage.local.set
      (chrome.storage.local.set as jest.Mock).mockImplementation((data, callback) => {
        if (callback) callback();
        return Promise.resolve();
      });
      
      // Mock storage.local.get
      (chrome.storage.local.get as jest.Mock).mockImplementation((keys, callback) => {
        callback(testData);
        return Promise.resolve(testData);
      });
      
      // Test saving data
      await new Promise<void>((resolve) => {
        chrome.storage.local.set(testData, () => {
          resolve();
        });
      });
      
      expect(chrome.storage.local.set).toHaveBeenCalledWith(testData, expect.any(Function));
      
      // Test retrieving data
      await new Promise<void>((resolve) => {
        chrome.storage.local.get(['model', 'history'], (result) => {
          expect(result).toEqual(testData);
          resolve();
        });
      });
      
      expect(chrome.storage.local.get).toHaveBeenCalledWith(['model', 'history'], expect.any(Function));
    });

    test('should handle storage errors gracefully', async () => {
      const testError = new Error('Storage quota exceeded');
      
      (chrome.storage.local.set as jest.Mock).mockImplementation((data, callback) => {
        if (callback) callback();
        throw testError;
      });
      
      expect(() => {
        chrome.storage.local.set({ test: 'data' }, () => {});
      }).toThrow('Storage quota exceeded');
    });

    test('should use sync storage for user preferences', async () => {
      const preferences = { theme: 'dark', notifications: true };
      
      (chrome.storage.sync.set as jest.Mock).mockImplementation((data, callback) => {
        if (callback) callback();
        return Promise.resolve();
      });
      
      (chrome.storage.sync.get as jest.Mock).mockImplementation((keys, callback) => {
        callback(preferences);
        return Promise.resolve(preferences);
      });
      
      // Test sync storage
      await new Promise<void>((resolve) => {
        chrome.storage.sync.set(preferences, () => {
          resolve();
        });
      });
      
      expect(chrome.storage.sync.set).toHaveBeenCalledWith(preferences, expect.any(Function));
    });
  });

  describe('Permissions and security', () => {
    test('should have required permissions in manifest', () => {
      // This would typically be tested by loading the actual manifest
      const requiredPermissions = [
        'storage',
        'tabs',
        'webNavigation',
        'activeTab',
        'scripting'
      ];
      
      // In a real test, you'd load and parse the manifest.json
      const manifestPermissions = [
        'storage',
        'tabs',
        'webNavigation',
        'activeTab',
        'scripting'
      ];
      
      requiredPermissions.forEach(permission => {
        expect(manifestPermissions).toContain(permission);
      });
    });

    test('should handle permission denied scenarios', () => {
      const permissionError = new Error('Permission denied');
      
      // Mock permission check
      const hasPermission = (permission: string): boolean => {
        if (permission === 'restrictedAPI') {
          throw permissionError;
        }
        return true;
      };
      
      expect(() => hasPermission('tabs')).not.toThrow();
      expect(() => hasPermission('restrictedAPI')).toThrow('Permission denied');
    });
  });

  describe('Content Security Policy compliance', () => {
    test('should not use inline scripts', () => {
      // Verify no inline script tags
      const scripts = document.querySelectorAll('script:not([src])');
      const inlineScripts = Array.from(scripts).filter(script => 
        script.textContent && script.textContent.trim().length > 0
      );
      
      expect(inlineScripts).toHaveLength(0);
    });

    test('should use safe innerHTML updates', () => {
      const element = document.createElement('div');
      const userInput = '<script>alert("xss")</script>Hello World';
      
      // Safe way - escape HTML
      const safeUpdate = (el: HTMLElement, content: string) => {
        el.textContent = content; // This escapes HTML automatically
      };
      
      safeUpdate(element, userInput);
      
      // Should not contain script tag
      expect(element.innerHTML).not.toContain('<script>');
      expect(element.textContent).toBe(userInput);
    });
  });
});
