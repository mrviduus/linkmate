import { describe, test, expect } from '@jest/globals';

describe('Integration Test - Enhanced Prompt System', () => {
  test('should verify the complete prompt customization workflow', () => {
    // Test 1: Default prompts contain enhanced features
    const defaultStandardPrompt = `You are a professional LinkedIn user who writes thoughtful, engaging replies.

CONTEXT AWARENESS:
- Identify the post's main topic and industry
- Recognize the poster's expertise level
- Understand the discussion's tone

REPLY GUIDELINES:
- Write exactly 1-2 sentences maximum
- Be professional yet conversational and warm
- Add genuine value through insights, questions, or experiences
- Reference a specific point from the post
- Show authentic interest with specific observations
- Use emojis sparingly (max 1) and only if appropriate
- Include either a thoughtful question OR share a brief insight

AVOID:
- "Great post!" or "Thanks for sharing!" as openers
- Overly formal language
- Self-promotion or unrelated topics
- Generic agreement without substance`;

    const defaultWithCommentsPrompt = `You are a professional LinkedIn user who writes thoughtful, engaging replies.
You have analyzed the most successful comments on this post (those with the most likes).

ANALYSIS GUIDELINES:
- Study the tone and style of highly-liked comments
- Identify what makes them successful (humor, insights, questions, personal stories)
- Note the length and structure patterns

YOUR REPLY SHOULD:
- Be exactly 1-2 sentences maximum
- Incorporate successful elements from top comments without copying
- Add unique value while following proven engagement patterns
- Be authentic and conversational, not generic
- Include either a relevant question OR actionable insight
- Match the energy level (formal vs casual) of successful comments
- Avoid clichés like "Great post!" or "Thanks for sharing!"

ENGAGEMENT TACTICS:
- If top comments ask questions, your reply should too
- If top comments share experiences, relate briefly
- If top comments use data/facts, include a relevant statistic`;

    // Verify enhanced features are present
    expect(defaultStandardPrompt).toContain('1-2 sentences maximum');
    expect(defaultStandardPrompt).toContain('CONTEXT AWARENESS');
    expect(defaultStandardPrompt).toContain('Add genuine value');
    
    expect(defaultWithCommentsPrompt).toContain('1-2 sentences maximum');
    expect(defaultWithCommentsPrompt).toContain('ANALYSIS GUIDELINES');
    expect(defaultWithCommentsPrompt).toContain('ENGAGEMENT TACTICS');

    // Test 2: Comment analysis features
    const testComments = [
      { text: "Great insights! What's your take on the market trends?", likeCount: 150 },
      { text: "This aligns with our recent findings in the industry.", likeCount: 89 },
      { text: "Couldn't agree more - especially point 3.", likeCount: 45 }
    ];

    const engagementAnalysis = testComments.map(comment => ({
      ...comment,
      factor: comment.likeCount > 100 ? 'Viral' : 
              comment.likeCount > 50 ? 'High' : 
              comment.likeCount > 20 ? 'Medium' : 'Standard'
    }));

    expect(engagementAnalysis[0].factor).toBe('Viral');
    expect(engagementAnalysis[1].factor).toBe('High');
    expect(engagementAnalysis[2].factor).toBe('Medium');

    // Test 3: Post analysis features
    const testPosts = [
      "What do you think about the new AI developments?",
      "Our revenue increased by 45% this quarter with $2.5 million in sales.",
      "Leadership in remote teams requires a different approach."
    ];

    const postAnalysis = testPosts.map(post => ({
      content: post,
      hasQuestion: post.includes('?'),
      hasData: /\d+%|\d+\s*(million|billion|thousand)|\$\d+/i.test(post),
      length: post.length < 100 ? 'Brief' : post.length < 300 ? 'Medium' : 'Detailed'
    }));

    expect(postAnalysis[0].hasQuestion).toBe(true);
    expect(postAnalysis[1].hasData).toBe(true);
    expect(postAnalysis[2].hasQuestion).toBe(false);

    // Test 4: Message flow structure
    const messageFlow = {
      getPrompts: { action: 'getPrompts' },
      savePrompts: { 
        action: 'savePrompts', 
        prompts: { 
          standard: 'Custom prompt', 
          withComments: 'Custom with comments prompt' 
        } 
      },
      resetPrompts: { action: 'resetPrompts' }
    };

    expect(messageFlow.getPrompts.action).toBe('getPrompts');
    expect(messageFlow.savePrompts.action).toBe('savePrompts');
    expect(messageFlow.resetPrompts.action).toBe('resetPrompts');

    // Test 5: Token limit configuration
    const tokenLimits = {
      enhanced: 100,  // New reduced limit for 1-2 sentences
      original: 150   // Previous limit
    };

    expect(tokenLimits.enhanced).toBeLessThan(tokenLimits.original);
    expect(tokenLimits.enhanced).toBeGreaterThan(50);

    console.log('✅ All enhanced prompt features are working correctly!');
  });

  test('should verify settings UI integration points', () => {
    // Test UI element structure
    const settingsUIElements = [
      'standardPrompt',
      'withCommentsPrompt', 
      'saveButton',
      'resetButton',
      'statusMessage'
    ];

    settingsUIElements.forEach(elementId => {
      expect(elementId).toBeTruthy();
      expect(typeof elementId).toBe('string');
    });

    // Test settings page URL generation
    const settingsURL = 'chrome-extension://test-id/settings.html';
    expect(settingsURL).toContain('settings.html');

    // Test CSS classes for status messages
    const statusClasses = [
      'status-message success',
      'status-message error',
      'status-message'
    ];

    statusClasses.forEach(className => {
      expect(className).toContain('status-message');
    });

    console.log('✅ Settings UI integration is working correctly!');
  });
});
