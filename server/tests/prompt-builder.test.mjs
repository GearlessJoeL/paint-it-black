import assert from 'node:assert/strict';
import test from 'node:test';
import { extractLatexSlots } from '../latex-slots.mjs';
import { buildChatPrompt, buildTailorPrompt } from '../prompt-builder.mjs';

test('slot generation sees fixed qualifications and project context while only bullets remain editable', () => {
  const masterLatex = String.raw`\begin{document}
jane.doe@example.com
\section{Education}
\resumeSubheading{Example State University}{Expected 2027}{B.S. in Computer Science}{Example City}
\resumeItem{Coursework: Databases and Operating Systems.}
\section{Projects}
\resumeSubheading{Ticket Board}{2026}{Team course project}{}
\resumeItem{Implemented a FastAPI endpoint.}
\resumeProjectHeading{\textbf{CI Sandbox} $|$ \emph{Docker}}{2025}
\resumeItem{Ran local integration tests.}
\section{References}
Reference Contact
\end{document}`;
  const { slots } = extractLatexSlots(masterLatex);
  assert.deepEqual(slots.map(({ id }) => id), ['B1', 'B2']);

  const input = {
    masterFilename: 'resume.tex',
    masterLatex,
    slots,
    jobDescription: 'Required: enrollment in computer science and experience with Docker.',
  };
  for (const prompt of [buildTailorPrompt(input), buildChatPrompt({ ...input, userMessage: 'Generate' })]) {
    assert.match(prompt, /\[B1\][^\n]+Ticket Board[^\n]+Team course project/);
    assert.match(prompt, /\[B2\][^\n]+CI Sandbox[^\n]+Docker/);
    assert.match(prompt, /LOCKED QUALIFICATIONS[^]*B\.S\. in Computer Science[^]*Coursework: Databases and Operating Systems/);
    assert.doesNotMatch(prompt, /jane\.doe@example\.com|Reference Contact/);
  }
});
