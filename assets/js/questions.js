/**
 * questions.js
 * ------------------------------------------------------------
 * Static question bank for the Case Files interview tracker.
 * Kept separate from app logic so new rounds/categories can be
 * appended here without touching rendering or scoring code.
 * ------------------------------------------------------------
 */

const CASE_CATEGORIES = Object.freeze({
  BEHAVIORAL: "Behavioral",
  TECHNICAL: "Technical", // reserved for future rounds
});

const ROUNDS = [
  {
    id: 1,
    title: "Round 1",
    subtitle: "Behavioral",
  },
  {
    id: 2,
    title: "Round 2",
    subtitle: "AWS Services Knowledge",
  },
  {
    id: 3,
    title: "Round 3",
    subtitle: "Coding (Python)",
  },
  {
    id: 4,
    title: "Round 4",
    subtitle: "IaC / Scripting",
  },
  {
    id: 5,
    title: "Round 5",
    subtitle: "System Design (Lightweight)",
  },
  {
    id: 6,
    title: "Round 6",
    subtitle: "Troubleshooting Scenarios",
  },
];

const CASE_FILES = [
  { id: 1, round: 1, category: CASE_CATEGORIES.BEHAVIORAL, question: "Tell me about yourself." },
  { id: 2, round: 1, category: CASE_CATEGORIES.BEHAVIORAL, question: "Why are you moving from simulation engineering into cloud engineering?" },
  { id: 3, round: 1, category: CASE_CATEGORIES.BEHAVIORAL, question: "Walk me through a time you had to learn something completely new under pressure." },
  { id: 4, round: 1, category: CASE_CATEGORIES.BEHAVIORAL, question: "Tell me about a project you're proud of." },
  { id: 5, round: 1, category: CASE_CATEGORIES.BEHAVIORAL, question: "Describe a time you disagreed with a teammate, professor, or manager. How'd it resolve?" },
  { id: 6, round: 1, category: CASE_CATEGORIES.BEHAVIORAL, question: "Tell me about a time you failed at something. What did you learn?" },
  { id: 7, round: 1, category: CASE_CATEGORIES.BEHAVIORAL, question: "How do you handle ambiguous instructions or unclear requirements?" },
  { id: 8, round: 1, category: CASE_CATEGORIES.BEHAVIORAL, question: "Describe a time you had to explain something technical to someone non-technical." },
  { id: 9, round: 1, category: CASE_CATEGORIES.BEHAVIORAL, question: "Tell me about a time you managed multiple priorities or deadlines at once." },
  { id: 10, round: 1, category: CASE_CATEGORIES.BEHAVIORAL, question: "Why should we hire someone transitioning from a different engineering discipline?" },
  { id: 11, round: 1, category: CASE_CATEGORIES.BEHAVIORAL, question: "What's a technical decision you made that you'd do differently now?" },
  { id: 12, round: 1, category: CASE_CATEGORIES.BEHAVIORAL, question: "Tell me about a time you had to debug something with no clear starting point." },
];

const SCORE_CATEGORIES = [
  { key: "structure", label: "Structure", hint: "Clear STAR-style frame, not a ramble" },
  { key: "relevance", label: "Relevance", hint: "Actually answers this question" },
  { key: "clarity", label: "Clarity & Delivery", hint: "Concise, confident, low filler" },
  { key: "evidence", label: "Evidence", hint: "Specific details, tools, numbers" },
  { key: "impact", label: "Impact / Close", hint: "Lands the point cleanly" },
];

const RANKS = [
  { min: 0, title: "Rookie Detective", icon: "🔰", level: 1 },
  { min: 50, title: "Field Agent", icon: "🕶️", level: 2 },
  { min: 100, title: "Case Closer", icon: "🗂️", level: 3 },
  { min: 150, title: "Senior Investigator", icon: "🎯", level: 4 },
  { min: 200, title: "Lead Detective", icon: "🏆", level: 5 },
  { min: 250, title: "The Chief", icon: "👑", level: 6 },
];
