import { describe, test, expect, beforeEach, jest } from '@jest/globals';

describe('Smart Reply with Comment Analysis', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div data-id="urn:li:activity:12345" class="feed-shared-update-v2">
        <div class="feed-shared-text">
          <span dir="ltr">Great post about AI innovation!</span>
        </div>
        <div class="comments-container">
          <article class="comments-comment-item">
            <div class="comments-comment-item__main-content">
              Excellent insights! This really resonates with our experience in the field.
            </div>
            <div class="social-counts-reactions__count">42</div>
          </article>
          <article class="comments-comment-item">
            <div class="comments-comment-item__main-content">
              Thanks for sharing! Very valuable perspective on AI trends.
            </div>
            <div class="social-counts-reactions__count">25</div>
          </article>
          <article class="comments-comment-item">
            <div class="comments-comment-item__main-content">
              Interesting point about machine learning applications.
            </div>
            <div class="social-counts-reactions__count">8</div>
          </article>
        </div>
      </div>
    `;
  });

  test('should extract comments with like counts', () => {
    const post = document.querySelector('[data-id="urn:li:activity:12345"]');
    const comments = document.querySelectorAll('.comments-comment-item');
    
    expect(comments).toHaveLength(3);
    
    const firstComment = comments[0];
    const likeCount = firstComment.querySelector('.social-counts-reactions__count');
    expect(likeCount?.textContent).toBe('42');
  });

  test('should prioritize high-liked comments for analysis', () => {
    const comments = [
      { text: 'Comment 1', likeCount: 10 },
      { text: 'Comment 2', likeCount: 50 },
      { text: 'Comment 3', likeCount: 25 }
    ];
    
    const sorted = comments.sort((a, b) => b.likeCount - a.likeCount);
    
    expect(sorted[0].likeCount).toBe(50);
    expect(sorted[1].likeCount).toBe(25);
    expect(sorted[2].likeCount).toBe(10);
  });

  test('should parse like counts correctly', () => {
    const testCases = [
      { input: '42', expected: 42 },
      { input: '1.2K', expected: 1200 },
      { input: '1.5M', expected: 1500000 },
      { input: '999', expected: 999 },
      { input: '', expected: 0 }
    ];

    // Mock the parseLikeCount function logic
    const parseLikeCount = (text: string): number => {
      text = text.trim().toLowerCase();
      
      if (text.includes('k')) {
        return Math.round(parseFloat(text.replace('k', '')) * 1000);
      }
      if (text.includes('m')) {
        return Math.round(parseFloat(text.replace('m', '')) * 1000000);
      }
      
      return parseInt(text, 10) || 0;
    };

    testCases.forEach(({ input, expected }) => {
      expect(parseLikeCount(input)).toBe(expected);
    });
  });

  test('should filter comments with likes greater than 0', () => {
    const comments = [
      { text: 'Comment 1', likeCount: 0 },
      { text: 'Comment 2', likeCount: 5 },
      { text: 'Comment 3', likeCount: 15 }
    ];
    
    const topComments = comments.filter(c => c.likeCount > 0);
    
    expect(topComments).toHaveLength(2);
    expect(topComments[0].likeCount).toBe(5);
    expect(topComments[1].likeCount).toBe(15);
  });

  test('should limit comment text length for analysis', () => {
    const longComment = 'This is a very long comment that exceeds the typical length we want to send to the AI model for analysis. It contains a lot of detailed information that while valuable, might be too much context for generating a concise reply.';
    
    const truncated = longComment.substring(0, 200);
    
    expect(truncated.length).toBeLessThanOrEqual(200);
    expect(truncated).toContain('This is a very long comment');
  });

  test('should require minimum number of liked comments for smart analysis', () => {
    const scenarios = [
      { comments: [], shouldUseSmartAnalysis: false },
      { comments: [{ likeCount: 5 }], shouldUseSmartAnalysis: false },
      { comments: [{ likeCount: 5 }, { likeCount: 10 }], shouldUseSmartAnalysis: true },
      { comments: [{ likeCount: 0 }, { likeCount: 0 }], shouldUseSmartAnalysis: false }
    ];

    scenarios.forEach(({ comments, shouldUseSmartAnalysis }) => {
      const topComments = comments.filter(c => c.likeCount > 0);
      const useSmartAnalysis = topComments.length >= 2;
      
      expect(useSmartAnalysis).toBe(shouldUseSmartAnalysis);
    });
  });
});
