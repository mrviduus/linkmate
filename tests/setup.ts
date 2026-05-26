import '@testing-library/jest-dom';

// Mock Chrome APIs
const mockChrome = {
  runtime: {
    onMessage: {
      addListener: jest.fn(),
      removeListener: jest.fn(),
    },
    onConnect: {
      addListener: jest.fn(),
    },
    sendMessage: jest.fn(),
  },
  tabs: {
    query: jest.fn(),
    connect: jest.fn(),
  },
  storage: {
    local: {
      get: jest.fn(),
      set: jest.fn(),
      remove: jest.fn(),
    },
    sync: {
      get: jest.fn(),
      set: jest.fn(),
      remove: jest.fn(),
    },
  },
};

// Assign to global
(global as any).chrome = mockChrome;

// Mock navigator.clipboard
Object.assign(navigator, {
  clipboard: {
    writeText: jest.fn().mockResolvedValue(undefined),
    readText: jest.fn(),
  },
});

// Setup DOM
beforeEach(() => {
  document.body.innerHTML = '';
  jest.clearAllMocks();
});

// Mock innerText property for JSDOM compatibility
Object.defineProperty(Element.prototype, 'innerText', {
  get: function() {
    return this.textContent || '';
  },
  set: function(value) {
    this.textContent = value;
  },
  configurable: true
});
