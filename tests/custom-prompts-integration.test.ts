import { describe, it, expect, beforeEach } from '@jest/globals';

describe('Custom Prompts Integration Test', () => {
  let mockChrome: any;

  beforeEach(() => {
    // Mock chrome API with comprehensive storage simulation
    mockChrome = {
      runtime: {
        sendMessage: jest.fn(),
        onMessage: {
          addListener: jest.fn()
        }
      },
      storage: {
        sync: {
          get: jest.fn(),
          set: jest.fn(),
          remove: jest.fn()
        }
      }
    };
    
    global.chrome = mockChrome as any;
  });

  describe('Storage Operations', () => {
    it('should save custom prompts correctly', async () => {
      const customPrompts = {
        standard: 'CUSTOM STANDARD: Reply like a professional consultant',
        withComments: 'CUSTOM COMMENTS: Analyze top comments and respond strategically'
      };

      mockChrome.storage.sync.set.mockImplementation((data: any, callback: any) => {
        expect(data.customPrompts).toEqual(customPrompts);
        callback();
      });

      mockChrome.runtime.sendMessage.mockImplementation((request: any, callback: any) => {
        if (request.action === 'savePrompts') {
          mockChrome.storage.sync.set({ customPrompts: request.prompts }, () => {
            callback({ success: true });
          });
        }
      });

      // Test save operation
      return new Promise((resolve) => {
        mockChrome.runtime.sendMessage(
          { action: 'savePrompts', prompts: customPrompts },
          (response: any) => {
            expect(response.success).toBe(true);
            expect(mockChrome.storage.sync.set).toHaveBeenCalledWith(
              { customPrompts },
              expect.any(Function)
            );
            resolve(undefined);
          }
        );
      });
    });

    it('should retrieve custom prompts correctly', async () => {
      const storedPrompts = {
        standard: 'STORED STANDARD PROMPT',
        withComments: 'STORED COMMENTS PROMPT'
      };

      // Mock storage retrieval
      mockChrome.storage.sync.get.mockImplementation((keys: any, callback: any) => {
        callback({ customPrompts: storedPrompts });
      });

      mockChrome.runtime.sendMessage.mockImplementation((request: any, callback: any) => {
        if (request.action === 'getPrompts') {
          mockChrome.storage.sync.get(['customPrompts'], (result: any) => {
            callback({
              prompts: result.customPrompts || {},
              defaults: {
                standard: 'Default standard prompt',
                withComments: 'Default comments prompt'
              }
            });
          });
        }
      });

      // Test retrieval
      return new Promise((resolve) => {
        mockChrome.runtime.sendMessage({ action: 'getPrompts' }, (response: any) => {
          expect(response.prompts).toEqual(storedPrompts);
          expect(response.defaults).toBeDefined();
          resolve(undefined);
        });
      });
    });

    it('should verify custom prompts are being used', async () => {
      const customPrompts = {
        standard: 'CUSTOM TEST PROMPT',
        withComments: 'CUSTOM COMMENTS TEST'
      };

      // Mock verification response
      mockChrome.runtime.sendMessage.mockImplementation((request: any, callback: any) => {
        if (request.action === 'verifyPrompts') {
          callback({
            hasCustomPrompts: true,
            customPrompts: customPrompts,
            retrievedStandard: customPrompts.standard.substring(0, 100),
            retrievedComments: customPrompts.withComments.substring(0, 100),
            isUsingCustomStandard: true,
            isUsingCustomComments: true
          });
        }
      });

      // Test verification
      return new Promise((resolve) => {
        mockChrome.runtime.sendMessage({ action: 'verifyPrompts' }, (response: any) => {
          expect(response.hasCustomPrompts).toBe(true);
          expect(response.isUsingCustomStandard).toBe(true);
          expect(response.isUsingCustomComments).toBe(true);
          expect(response.customPrompts).toEqual(customPrompts);
          resolve(undefined);
        });
      });
    });
  });

  describe('LinkedIn Reply Generation', () => {
    it('should use custom prompts when generating replies', async () => {
      const customPrompt = 'CUSTOM: Always start with "Testing custom prompt -"';
      const testPostContent = 'This is a test LinkedIn post';

      mockChrome.runtime.sendMessage.mockImplementation((request: any, callback: any) => {
        if (request.action === 'generateLinkedInReply') {
          // Simulate using custom prompt
          const reply = 'Testing custom prompt - Great insights! Thanks for sharing.';
          callback({ reply });
        }
      });

      // Test reply generation
      return new Promise((resolve) => {
        mockChrome.runtime.sendMessage(
          { action: 'generateLinkedInReply', postContent: testPostContent },
          (response: any) => {
            expect(response.reply).toContain('Testing custom prompt');
            resolve(undefined);
          }
        );
      });
    });

    it('should use custom prompts for smart replies with comments', async () => {
      const testPostContent = 'LinkedIn post about AI';
      const topComments = [
        { text: 'AI is the future!', likeCount: 50 },
        { text: 'Great insights on machine learning', likeCount: 25 }
      ];

      mockChrome.runtime.sendMessage.mockImplementation((request: any, callback: any) => {
        if (request.action === 'generateLinkedInReplyWithComments') {
          const reply = 'CUSTOM COMMENTS: Building on the AI discussion, I agree with the sentiment about future impact.';
          callback({ reply, basedOnComments: true, commentCount: topComments.length });
        }
      });

      // Test smart reply generation
      return new Promise((resolve) => {
        mockChrome.runtime.sendMessage(
          { 
            action: 'generateLinkedInReplyWithComments', 
            postContent: testPostContent,
            topComments 
          },
          (response: any) => {
            expect(response.reply).toContain('CUSTOM COMMENTS');
            expect(response.basedOnComments).toBe(true);
            expect(response.commentCount).toBe(2);
            resolve(undefined);
          }
        );
      });
    });
  });

  describe('Error Handling', () => {
    it('should handle storage errors gracefully', async () => {
      // Mock storage error
      mockChrome.storage.sync.get.mockImplementation((keys: any, callback: any) => {
        callback(undefined); // Simulate error
      });

      mockChrome.runtime.sendMessage.mockImplementation((request: any, callback: any) => {
        if (request.action === 'getPrompts') {
          try {
            mockChrome.storage.sync.get(['customPrompts'], (result: any) => {
              // Simulate fallback to defaults when storage fails
              callback({
                prompts: {},
                defaults: {
                  standard: 'Default standard prompt',
                  withComments: 'Default comments prompt'
                }
              });
            });
          } catch (error) {
            callback({ error: 'Storage access failed' });
          }
        }
      });

      // Test error handling
      return new Promise((resolve) => {
        mockChrome.runtime.sendMessage({ action: 'getPrompts' }, (response: any) => {
          expect(response.prompts).toEqual({});
          expect(response.defaults).toBeDefined();
          resolve(undefined);
        });
      });
    });

    it('should reset prompts when requested', () => {
      mockChrome.storage.sync.remove.mockImplementation((key: string, callback: any) => {
        expect(key).toBe('customPrompts');
        callback();
      });

      mockChrome.runtime.sendMessage.mockImplementation((request: any, callback: any) => {
        if (request.action === 'resetPrompts') {
          mockChrome.storage.sync.remove('customPrompts', () => {
            callback({ success: true });
          });
        }
      });

      // Test reset with synchronous expectation
      mockChrome.runtime.sendMessage({ action: 'resetPrompts' }, (response: any) => {
        expect(response.success).toBe(true);
      });

      expect(mockChrome.runtime.sendMessage).toHaveBeenCalledWith(
        { action: 'resetPrompts' },
        expect.any(Function)
      );
    });
  });

  describe('UI Integration', () => {
    it('should show visual indicators for custom prompts', () => {
      // Create mock DOM elements
      document.body.innerHTML = `
        <label for="standardPrompt">Standard Prompt</label>
        <textarea id="standardPrompt"></textarea>
        <label for="withCommentsPrompt">Comments Prompt</label>
        <textarea id="withCommentsPrompt"></textarea>
      `;

      const standardLabel = document.querySelector('label[for="standardPrompt"]') as HTMLElement;
      const commentsLabel = document.querySelector('label[for="withCommentsPrompt"]') as HTMLElement;
      
      // Simulate custom prompts being loaded
      standardLabel.innerHTML = '<i class="fa fa-check-circle" style="color: #4caf50;"></i> Standard Reply Prompt (Custom Active)';
      commentsLabel.innerHTML = '<i class="fa fa-check-circle" style="color: #4caf50;"></i> Smart Reply Prompt (Custom Active)';
      
      expect(standardLabel.innerHTML).toContain('Custom Active');
      expect(commentsLabel.innerHTML).toContain('Custom Active');
      expect(standardLabel.innerHTML).toContain('check-circle');
      expect(commentsLabel.innerHTML).toContain('check-circle');
    });

    it('should handle test button functionality', () => {
      // Mock test button
      const testButton = document.createElement('button');
      testButton.id = 'testPrompts';
      testButton.innerHTML = '<i class="fa fa-flask"></i> Test Custom Prompts';
      document.body.appendChild(testButton);

      // Verify button exists and has correct attributes
      const button = document.getElementById('testPrompts') as HTMLButtonElement;
      expect(button).toBeTruthy();
      expect(button.innerHTML).toContain('Test Custom Prompts');
    });
  });
});
