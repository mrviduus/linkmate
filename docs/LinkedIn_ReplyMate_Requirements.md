# LinkedIn Reply Generation Feature – High‑Level Requirements

> **Purpose**  
> Enhance the existing LinkMate Chrome extension so users can generate AI‑powered comments directly on LinkedIn posts while **keeping the current chat panel fully functional for manual testing**.

---

## 1. Scope
- **In‑Scope**  
  - Detect LinkedIn feed posts.  
  - Provide one‑click **Generate Reply** functionality for each post.  
  - Offer **Regenerate**, **Copy**, and **Insert** actions for the generated text.  
  - Maintain stylistic harmony with LinkedIn’s native interface.  

- **Out‑of‑Scope**  
  - Changes to the core chat popup UI.  
  - Support for platforms other than LinkedIn.  

---

## 2. Functional Requirements
| ID | Requirement |
|----|-------------|
| F‑1 | The extension must recognise when a user is on any `linkedin.com` page. |
| F‑2 | It must automatically locate each visible post in the feed as the user scrolls. |
| F‑3 | For every located post, a **Generate Reply** button must appear near the existing “Send” / comment controls. |
| F‑4 | When clicked, the button must send the post’s text to the already‑integrated local model and request a comment. |
| F‑5 | The generated comment must display in a compact reply panel directly beneath the post. |
| F‑6 | The panel must include three controls: **Regenerate** (creates a new suggestion), **Copy** (copies to clipboard), **Insert** (places the text in LinkedIn’s comment field). |
| F‑7 | All features must keep working as new posts load dynamically (infinite scrolling). |
| F‑8 | Added UI must blend with LinkedIn styles and not obstruct standard functionality. |
| F‑9 | Users must be warned (e.g., via console log) that automated interactions can violate LinkedIn Terms of Service. |
| F‑10 | The solution must comply with Chrome Manifest V3 and integrate cleanly with existing background logic. |

---

## 3. Non‑Functional Requirements
- **Performance** – UI injection and model calls must not noticeably slow page scrolling or interaction.  
- **Accessibility** – All new interactive elements must be keyboard‑navigable and labelled for screen readers.  
- **Reliability** – The feature should fail gracefully if the model is unavailable or LinkedIn’s DOM changes.  
- **Backward Compatibility** – Existing chat functionality must remain uninterrupted.  

---

## 4. Acceptance Criteria
1. **Visibility** – The **Generate Reply** button appears on at least 95 % of visible posts.  
2. **Response Time** – A comment is returned within 3 seconds in typical use.  
3. **Action Buttons** – Regenerate, Copy, and Insert each perform their functions without errors.  
4. **Styling** – Lighthouse audit shows no significant visual regressions.  
5. **Compliance Reminder** – Opening the LinkedIn page logs a clear ToS warning in the dev console.  

---

## 5. Deliverables
- Updated extension manifest with LinkedIn permissions.  
- New content script and styles for LinkedIn integration.  
- Background logic updates for request handling.  
- A short README section documenting usage and limitations.  

---

## 6. Milestones (Suggested)
1. **Kick‑off & Design Confirmation** – 0.5 day  
2. **DOM Detection & Button Injection** – 1 day  
3. **Model Request Wiring** – 0.5 day  
4. **UI Panel & Action Buttons** – 1 day  
5. **Infinite Scroll Handling** – 0.5 day  
6. **Polish, Accessibility, Compliance Warning** – 0.5 day  
7. **Testing & Documentation** – 1 day  

_Total estimated effort: ~5 developer‑days._

---

**End of requirements**  
