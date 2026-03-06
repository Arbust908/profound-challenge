# Frontend Engineering Challenge — URL Summarization Workspace

Thank you for your interest in joining our team\! This take-home challenge is intentionally compact while revealing how you think about React architecture, data modeling, and API design.

**1\. Overview**

Build a small web application that lets users generate LLM-powered summaries of webpages.

* A user enters a URL  
* An LLM generates a summary that streams in real-time  
* That summary is persisted  
* The user can later search, view, copy, download or delete sessions

A session represents one summarized URL and contains the original URL, the generated summary, and relevant metadata.

**Important**: You must use an actual LLM API (OpenAI, Anthropic, Google Gemini, etc.). Mock or simulated responses are not acceptable.

**2\. Required features**

* **List of Sessions** — Display all previously created sessions with basic identifying info (URL, title, etc.)  
* **Search & Filter** — Filter the session list by URL or content, updating as the user types  
* **Create New Summary** — Submit a URL to generate a summary. The response must stream progressively into the UI, not appear only after completion  
* **View a Session** — Select a session to display its summary and metadata  
* **Delete a Session** — Remove a session with the UI updating accordingly  
* **Edge Case Handling** — Handle errors gracefully: unreachable URLs, pages with no content, LLM failures mid-stream. The user should always receive clear feedback

**3\. API Layer**

Your app must include an API layer between the frontend and data/LLM services. At minimum, support: create, list, get, delete, and search sessions, plus LLM integration with streaming and webpage content fetching. How you design this — URL structure, patterns, abstractions — is entirely up to you.

**4\. Data storage**

All session data must be persisted (database, localStorage, or any storage you choose).

**5\. Figma Design**

Design file: [Figma Link](https://www.figma.com/design/ltkR4niWxYqLJ0ELvnOhp4/FE-challenge?node-id=0-1&p=f)

**Your implementation must follow the provided design closely**. Spacing, typography, layout, colors, and component structure should match the Figma accurately. This is one of the most important aspects of the evaluation.

Small improvements and refinements are welcome as long as the core design stays intact. We value attention to detail, micro-animations, and thoughtful enhancements.

**6\. Technology**

**Required**: React, TypeScript

**Optional**: Next.js, React Router, Tailwind, state management libraries, or any other tools you prefer.

**7\. Optional Enhancements**

Not required, but welcome: URL validation, page title extraction, retry logic, tests, sidebar grouping. Skipping these will not affect your evaluation.

**8\. Evaluation Criteria**

We assess overall engineering quality over feature count:

* **Code Structure** — Organization, separation of concerns, file layout  
* **State Modeling** — Data representation, correctness, maintainability  
* **Component Design** — Composition, reuse, React best practices  
* **React & TypeScript** — Hooks, typing, API modeling  
* **Data Flow** — Predictability from API to UI, including streaming  
* **Design Fidelity** — Accuracy to the Figma: layout, spacing, typography, colors  
* **Error Handling** — Graceful failures with clear user feedback  
* **UX Correctness** — Loading/error states, functional interactions, user flow  
* **Overall Craftsmanship** — Trade-offs, naming, consistency, maintainability

**Submission**

* **Private GitHub repo** — Add as collaborators: dbabbs, chazzhou, mishojan, lucasromerodb, joeydotdev  
* **Public preview URL**  
* **README** with setup instructions  
* **Brief note** on design decisions and what you'd improve with more time

About Profound and Engineering Culture

Profound is building the infrastructure layer for marketing in the generative internet. We're a data, search, and applied AI company at our core. Today, that means helping brands understand where and how they appear across AI interfaces like ChatGPT and Perplexity. Tomorrow, it means being the infrastructure companies rely on as AI agents, generative ads, and new discovery surfaces reshape how consumers find information.

In engineering, we value speed, craftsmanship, and clear communication. As Linus Torvalds said, "Talk is cheap; show me the code." This project is your chance to show us how you think, build, and ship.

