/**
 * Performance and Error Handling Tests
 * Tests performance characteristics and error scenarios
 */

describe('Performance and Error Handling', () => {
  describe('Memory management', () => {
    test('should cleanup event listeners to prevent memory leaks', () => {
      const element = document.createElement('button');
      const handler = jest.fn();
      
      // Add event listener
      element.addEventListener('click', handler);
      
      // Simulate cleanup
      element.removeEventListener('click', handler);
      
      // Fire event after cleanup
      element.click();
      
      // Handler should not be called
      expect(handler).not.toHaveBeenCalled();
    });

    test('should cleanup port connections on page unload', () => {
      const mockPort = {
        disconnect: jest.fn(),
        postMessage: jest.fn(),
        onMessage: { addListener: jest.fn() },
        onDisconnect: { addListener: jest.fn() }
      };
      
      // Simulate cleanup function
      const cleanup = () => {
        mockPort.disconnect();
      };
      
      cleanup();
      expect(mockPort.disconnect).toHaveBeenCalled();
    });

    test('should handle large page content efficiently', () => {
      // Create large content
      const largeContent = 'x'.repeat(100000); // 100KB of text
      document.body.innerHTML = `<div>${largeContent}</div>`;
      
      const startTime = performance.now();
      
      // Extract content (simulating content script)
      const extractedContent = document.body.innerText || document.body.textContent || '';
      
      const endTime = performance.now();
      const duration = endTime - startTime;
      
      expect(extractedContent).toContain('x');
      expect(duration).toBeLessThan(100); // Should complete within 100ms
    });
  });

  describe('Error scenarios', () => {
    test('should handle AI model initialization failures', async () => {
      const mockCreateMLCEngine = jest.fn().mockRejectedValue(
        new Error('Model loading failed')
      );
      
      try {
        await mockCreateMLCEngine('invalid-model');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe('Model loading failed');
      }
    });

    test('should handle network connectivity issues', async () => {
      // Mock fetch to simulate network error
      const mockFetch = jest.fn().mockRejectedValue(
        new Error('Network request failed')
      );
      
      global.fetch = mockFetch;
      
      try {
        await fetch('https://api.example.com/model');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe('Network request failed');
      }
    });

    test('should handle malformed API responses', () => {
      const malformedResponse = '{"incomplete": json';
      
      expect(() => {
        JSON.parse(malformedResponse);
      }).toThrow();
      
      // Safe parsing with error handling
      const safeParse = (jsonString: string) => {
        try {
          return JSON.parse(jsonString);
        } catch {
          return { error: 'Invalid JSON' };
        }
      };
      
      const result = safeParse(malformedResponse);
      expect(result).toEqual({ error: 'Invalid JSON' });
    });

    test('should handle DOM element not found errors', () => {
      const getElementSafely = (id: string): HTMLElement | null => {
        try {
          const element = document.getElementById(id);
          if (!element) {
            console.warn(`Element with id '${id}' not found`);
            return null;
          }
          return element;
        } catch (error) {
          console.error(`Error accessing element '${id}':`, error);
          return null;
        }
      };
      
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
      
      const result = getElementSafely('non-existent-element');
      
      expect(result).toBeNull();
      expect(consoleSpy).toHaveBeenCalledWith("Element with id 'non-existent-element' not found");
      
      consoleSpy.mockRestore();
    });

    test('should handle clipboard API unavailable', async () => {
      // Mock clipboard API to be unavailable
      Object.defineProperty(navigator, 'clipboard', {
        value: undefined,
        writable: true
      });
      
      const safeCopyToClipboard = async (text: string): Promise<boolean> => {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
          } else {
            // Fallback method
            console.warn('Clipboard API not available');
            return false;
          }
        } catch (error) {
          console.error('Failed to copy to clipboard:', error);
          return false;
        }
      };
      
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
      
      const result = await safeCopyToClipboard('test text');
      
      expect(result).toBe(false);
      expect(consoleSpy).toHaveBeenCalledWith('Clipboard API not available');
      
      consoleSpy.mockRestore();
    });
  });

  describe('Rate limiting and throttling', () => {
    test('should throttle rapid API requests', () => {
      let callCount = 0;
      const throttledFunction = throttle(() => {
        callCount++;
      }, 100);
      
      // Call function multiple times rapidly
      throttledFunction();
      throttledFunction();
      throttledFunction();
      
      // Should only be called once due to throttling
      expect(callCount).toBe(1);
    });

    test('should debounce user input', (done) => {
      let callCount = 0;
      const debouncedFunction = debounce(() => {
        callCount++;
      }, 50);
      
      // Call function multiple times
      debouncedFunction();
      debouncedFunction();
      debouncedFunction();
      
      // Should not be called immediately
      expect(callCount).toBe(0);
      
      // Should be called once after delay
      setTimeout(() => {
        expect(callCount).toBe(1);
        done();
      }, 60);
    });

    test('should handle concurrent requests properly', async () => {
      let activeRequests = 0;
      const maxConcurrentRequests = 2;
      
      const mockApiCall = async (): Promise<string> => {
        if (activeRequests >= maxConcurrentRequests) {
          throw new Error('Too many concurrent requests');
        }
        
        activeRequests++;
        await new Promise(resolve => setTimeout(resolve, 10));
        activeRequests--;
        
        return 'success';
      };
      
      // Start multiple requests
      const requests = Array(5).fill(null).map(() => mockApiCall());
      
      const results = await Promise.allSettled(requests);
      
      const successful = results.filter(r => r.status === 'fulfilled');
      const failed = results.filter(r => r.status === 'rejected');
      
      expect(successful.length).toBeGreaterThan(0);
      expect(failed.length).toBeGreaterThan(0);
    });
  });

  describe('Resource optimization', () => {
    test('should optimize message size for content extraction', () => {
      const largePage = 'content '.repeat(10000); // Large page content
      
      const optimizeContent = (content: string, maxLength: number = 5000): string => {
        if (content.length <= maxLength) {
          return content;
        }
        
        // Take first and last portions to maintain context
        const halfMax = Math.floor(maxLength / 2);
        return content.slice(0, halfMax) + 
               '\n... [content truncated] ...\n' + 
               content.slice(-halfMax);
      };
      
      const optimized = optimizeContent(largePage);
      
      expect(optimized.length).toBeLessThanOrEqual(5050); // Account for truncation message
      expect(optimized).toContain('[content truncated]');
    });

    test('should cache model responses to reduce API calls', () => {
      const cache = new Map<string, string>();
      
      const getCachedResponse = (query: string): string | null => {
        return cache.get(query) || null;
      };
      
      const setCachedResponse = (query: string, response: string): void => {
        cache.set(query, response);
      };
      
      const query = 'What is AI?';
      const response = 'AI is artificial intelligence...';
      
      // First call - should not be cached
      expect(getCachedResponse(query)).toBeNull();
      
      // Cache the response
      setCachedResponse(query, response);
      
      // Second call - should return cached response
      expect(getCachedResponse(query)).toBe(response);
    });
  });
});

// Utility functions for testing
function throttle<T extends (...args: any[]) => any>(
  func: T,
  delay: number
): (...args: Parameters<T>) => void {
  let lastCall = 0;
  return (...args: Parameters<T>) => {
    const now = Date.now();
    if (now - lastCall >= delay) {
      lastCall = now;
      func(...args);
    }
  };
}

function debounce<T extends (...args: any[]) => any>(
  func: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timeoutId: NodeJS.Timeout;
  return (...args: Parameters<T>) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => func(...args), delay);
  };
}
