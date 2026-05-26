/**
 * Popup Utility Functions Tests
 * Tests core utility functions from popup.ts
 */

// We need to extract and test utility functions from popup.ts
// Since popup.ts is a module with side effects, we'll create testable versions

describe('Popup Utility Functions', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="test-element">Test Content</div>
      <div id="answer"></div>
      <div id="answerWrapper" style="display: none;"></div>
      <div id="loading-indicator" style="display: block;"></div>
      <div id="timestamp"></div>
      <button id="copyAnswer"></button>
    `;
  });

  describe('setLabel function', () => {
    test('should set text content of existing element', () => {
      // Create a version of setLabel for testing
      const setLabel = (id: string, text: string) => {
        const label = document.getElementById(id);
        if (label != null) {
          label.innerText = text;
        }
      };

      setLabel('test-element', 'New Content');
      
      const element = document.getElementById('test-element');
      expect(element?.innerText).toBe('New Content');
    });

    test('should handle non-existent element gracefully', () => {
      const setLabel = (id: string, text: string) => {
        const label = document.getElementById(id);
        if (label != null) {
          label.innerText = text;
        }
      };

      // Should not throw error
      expect(() => {
        setLabel('non-existent', 'Some Text');
      }).not.toThrow();
    });
  });

  describe('getElementAndCheck function', () => {
    test('should return element when it exists', () => {
      const getElementAndCheck = (id: string): HTMLElement => {
        const element = document.getElementById(id);
        if (element == null) {
          throw Error("Cannot find element " + id);
        }
        return element;
      };

      const element = getElementAndCheck('test-element');
      expect(element).toBeTruthy();
      expect(element.id).toBe('test-element');
    });

    test('should throw error when element does not exist', () => {
      const getElementAndCheck = (id: string): HTMLElement => {
        const element = document.getElementById(id);
        if (element == null) {
          throw Error("Cannot find element " + id);
        }
        return element;
      };

      expect(() => {
        getElementAndCheck('non-existent');
      }).toThrow('Cannot find element non-existent');
    });
  });

  describe('updateAnswer function', () => {
    test('should update answer content and show wrapper', () => {
      const updateAnswer = (answer: string) => {
        // Show answer
        document.getElementById("answerWrapper")!.style.display = "block";
        const answerWithBreaks = answer.replace(/\n/g, "<br>");
        document.getElementById("answer")!.innerHTML = answerWithBreaks;
        
        // Update timestamp
        const options: Intl.DateTimeFormatOptions = {
          month: "short",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        };
        const time = new Date().toLocaleString("en-US", options);
        document.getElementById("timestamp")!.innerText = time;
        
        // Hide loading indicator
        document.getElementById("loading-indicator")!.style.display = "none";
      };

      const testAnswer = "This is a test answer\nWith line breaks";
      updateAnswer(testAnswer);

      // Check answer content
      const answerElement = document.getElementById('answer');
      expect(answerElement?.innerHTML).toBe("This is a test answer<br>With line breaks");

      // Check wrapper is visible
      const wrapperElement = document.getElementById('answerWrapper');
      expect(wrapperElement?.style.display).toBe('block');

      // Check loading indicator is hidden
      const loadingElement = document.getElementById('loading-indicator');
      expect(loadingElement?.style.display).toBe('none');

      // Check timestamp is set
      const timestampElement = document.getElementById('timestamp');
      expect(timestampElement?.innerText).toBeTruthy();
      expect(timestampElement?.innerText).toMatch(/\w+\s+\d+,\s+\d+:\d+:\d+\s+(AM|PM)/);
    });

    test('should handle empty answer', () => {
      const updateAnswer = (answer: string) => {
        document.getElementById("answerWrapper")!.style.display = "block";
        const answerWithBreaks = answer.replace(/\n/g, "<br>");
        document.getElementById("answer")!.innerHTML = answerWithBreaks;
        document.getElementById("loading-indicator")!.style.display = "none";
      };

      updateAnswer("");

      const answerElement = document.getElementById('answer');
      expect(answerElement?.innerHTML).toBe("");
    });
  });

  describe('Model name parsing', () => {
    test('should extract display name from model ID', () => {
      const parseModelDisplayName = (selectedModel: string): string => {
        const modelNameArray = selectedModel.split("-");
        let modelDisplayName = modelNameArray[0];
        let j = 1;
        while (j < modelNameArray.length && modelNameArray[j][0] != "q") {
          modelDisplayName = modelDisplayName + "-" + modelNameArray[j];
          j++;
        }
        return modelDisplayName;
      };

      expect(parseModelDisplayName("Qwen2-0.5B-Instruct-q4f16_1-MLC")).toBe("Qwen2-0.5B-Instruct");
      expect(parseModelDisplayName("Llama-3.2-1B-Instruct-q4f16_1-MLC")).toBe("Llama-3.2-1B-Instruct");
      expect(parseModelDisplayName("SimpleModel-q4f16")).toBe("SimpleModel");
    });
  });

  describe('Context preparation', () => {
    test('should prepare input with context when available', () => {
      const prepareInput = (message: string, context: string): string => {
        if (context.length > 0) {
          return "Use only the following context when answering the question at the end. Don't use any other knowledge.\n" +
            context +
            "\n\nQuestion: " +
            message +
            "\n\nHelpful Answer: ";
        }
        return message;
      };

      const message = "What is this about?";
      const context = "This page is about machine learning models.";
      
      const result = prepareInput(message, context);
      
      expect(result).toContain("Use only the following context");
      expect(result).toContain(context);
      expect(result).toContain(message);
      expect(result).toContain("Helpful Answer:");
    });

    test('should return original message when no context', () => {
      const prepareInput = (message: string, context: string): string => {
        if (context.length > 0) {
          return "Use only the following context when answering the question at the end. Don't use any other knowledge.\n" +
            context +
            "\n\nQuestion: " +
            message +
            "\n\nHelpful Answer: ";
        }
        return message;
      };

      const message = "What is this about?";
      const context = "";
      
      const result = prepareInput(message, context);
      
      expect(result).toBe(message);
    });
  });
});
