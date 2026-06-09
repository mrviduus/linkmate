import '@testing-library/jest-dom';

// Mock Chrome APIs
const mockChrome = {
  runtime: {
    // Real content scripts always carry an id; it only goes undefined once the
    // extension context is invalidated. Overlay's contextInvalidated() guard
    // relies on this, so the mock must provide one.
    id: 'test-extension-id',
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
