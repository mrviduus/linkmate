type LinkMateAnalyzeResponse = {
  ok?: boolean;
  analysis?: unknown;
  scored?: unknown[];
  error?: string;
};

type LinkMateWindow = Window & {
  linkmateAnalyzeFeed?: () => Promise<LinkMateAnalyzeResponse>;
  linkmateGetFeedAnalysis?: () => Promise<LinkMateAnalyzeResponse>;
  __linkmateConsoleBridgeInstalled?: boolean;
};

(() => {
  const win = window as LinkMateWindow;
  if (win.__linkmateConsoleBridgeInstalled) return;
  win.__linkmateConsoleBridgeInstalled = true;

  function request(action: 'analyzeFeed' | 'getFeedAnalysis'): Promise<LinkMateAnalyzeResponse> {
    const requestId = `linkmate-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    return new Promise((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        window.removeEventListener('message', onMessage);
        reject(new Error(`LinkMate ${action} timed out. Reload the extension and refresh LinkedIn.`));
      }, 15_000);

      function onMessage(event: MessageEvent): void {
        if (event.source !== window) return;
        const data = event.data as {
          type?: string;
          requestId?: string;
          payload?: LinkMateAnalyzeResponse;
        };
        if (data?.type !== 'LINKMATE_CONSOLE_RESPONSE' || data.requestId !== requestId) return;

        window.clearTimeout(timeoutId);
        window.removeEventListener('message', onMessage);
        resolve(data.payload ?? {});
      }

      window.addEventListener('message', onMessage);
      window.postMessage({ type: 'LINKMATE_CONSOLE_REQUEST', action, requestId }, '*');
    });
  }

  win.linkmateAnalyzeFeed = async () => {
    const response = await request('analyzeFeed');
    console.log('[LinkMate] Feed analysis API response:', response);
    if (response.analysis && typeof response.analysis === 'object') {
      const items = (response.analysis as { items?: Array<Record<string, unknown>> }).items ?? [];
      console.table(
        items.map((item) => {
          const post = item.post as Record<string, unknown> | undefined;
          const score = item.score as Record<string, unknown> | undefined;
          const sections = item.sections as Record<string, unknown> | undefined;
          return {
            postId: post?.id,
            author: post?.authorName,
            score: score?.value,
            category: score?.category,
            highlight: item.highlight,
            tags: Array.isArray(sections?.tags) ? sections.tags.join(', ') : '',
            recommendation: sections?.recommendation,
          };
        })
      );
    }
    return response;
  };

  win.linkmateGetFeedAnalysis = () => request('getFeedAnalysis');

  console.log('[LinkMate] Console helpers ready: await window.linkmateAnalyzeFeed()');
})();
