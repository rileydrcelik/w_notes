/**
 * Seed data for the notes app. Notes either live inside a folder
 * (`folderId` set) or directly on the home screen (`folderId: null`).
 *
 * These arrays are only the initial defaults: at runtime the live, editable
 * copy lives in the notes store (`@/store/notes-store`), which seeds itself
 * from here on first launch and then persists changes to local storage.
 */

export type Note = {
  id: string;
  title: string;
  body: string;
  folderId: string | null;
  updatedAt: string;
};

export type Folder = {
  id: string;
  name: string;
};

export const seedFolders: Folder[] = [
  { id: 'work', name: 'Work' },
  { id: 'personal', name: 'Personal' },
  { id: 'recipes', name: 'Recipes' },
  { id: 'travel', name: 'Travel' },
];

export const seedNotes: Note[] = [
  {
    id: 'quick-thought',
    title: 'Quick thought',
    body: 'Remember to back up the photos from the weekend before the phone storage fills up again.',
    folderId: null,
    updatedAt: '2026-06-05',
  },
  {
    id: 'shopping',
    title: 'Shopping list',
    body: 'Milk\nEggs\nCoffee beans\nOlive oil\nDishwasher tablets',
    folderId: null,
    updatedAt: '2026-06-04',
  },
  {
    id: 'standup',
    title: 'Standup notes',
    body: 'Yesterday: finished the dev build setup.\nToday: wire up navigation between screens.\nBlockers: none.',
    folderId: 'work',
    updatedAt: '2026-06-06',
  },
  {
    id: 'q3-goals',
    title: 'Q3 goals',
    body: 'Ship the notes app MVP.\nWrite onboarding docs.\nClean up the backlog.',
    folderId: 'work',
    updatedAt: '2026-06-02',
  },
  {
    id: 'one-on-one',
    title: '1:1 agenda',
    body: 'Career goals check-in.\nFeedback on the last project.\nUpcoming time off.',
    folderId: 'work',
    updatedAt: '2026-06-05',
  },
  {
    id: 'sprint-planning',
    title: 'Sprint planning',
    body: 'Carry over the navigation work.\nEstimate the settings screen.\nLeave room for bug fixes.',
    folderId: 'work',
    updatedAt: '2026-06-04',
  },
  {
    id: 'retro',
    title: 'Retro notes',
    body: 'Went well: faster reviews.\nImprove: flakier CI.\nTry: pairing on the hard tickets.',
    folderId: 'work',
    updatedAt: '2026-06-03',
  },
  {
    id: 'release-checklist',
    title: 'Release checklist',
    body: 'Bump version.\nUpdate changelog.\nSmoke test on a real device.\nTag the build.',
    folderId: 'work',
    updatedAt: '2026-06-01',
  },
  {
    id: 'interview-prep',
    title: 'Interview loop',
    body: 'Two screens, one system design, one behavioral. Send the panel the candidate packet.',
    folderId: 'work',
    updatedAt: '2026-05-31',
  },
  {
    id: 'expenses',
    title: 'Expense report',
    body: 'Conference ticket, two nights hotel, airport parking. Submit before month end.',
    folderId: 'work',
    updatedAt: '2026-05-30',
  },
  {
    id: 'roadmap',
    title: 'Roadmap draft',
    body: 'Q3: MVP + polish.\nQ4: sync and sharing.\nLater: web client.',
    folderId: 'work',
    updatedAt: '2026-05-28',
  },
  {
    id: 'oncall',
    title: 'On-call handoff',
    body: 'No open incidents.\nWatch the import job around midnight.\nRunbook link in the channel.',
    folderId: 'work',
    updatedAt: '2026-05-27',
  },
  {
    id: 'design-review',
    title: 'Design review',
    body: 'Tighten the empty states.\nConfirm the dark mode contrast.\nLock the icon set.',
    folderId: 'work',
    updatedAt: '2026-05-26',
  },
  {
    id: 'budget',
    title: 'Team budget',
    body: 'Tooling renewals, two conference passes, and a buffer for contractors.',
    folderId: 'work',
    updatedAt: '2026-05-24',
  },
  {
    id: 'okrs',
    title: 'OKR check-in',
    body: 'Activation up 12%.\nLatency down but not at target yet.\nRetention flat — needs a plan.',
    folderId: 'work',
    updatedAt: '2026-05-22',
  },
  {
    id: 'gift-ideas',
    title: 'Gift ideas',
    body: 'Mom: gardening gloves.\nAlex: that book about deep sea creatures.\nSam: concert tickets.',
    folderId: 'personal',
    updatedAt: '2026-05-30',
  },
  {
    id: 'pasta',
    title: 'Weeknight pasta',
    body: 'Garlic, chili flakes, olive oil, a splash of pasta water, parmesan. Toss with spaghetti. Done in 15 minutes.',
    folderId: 'recipes',
    updatedAt: '2026-05-28',
  },
  {
    id: 'banana-bread',
    title: 'Banana bread',
    body: '3 ripe bananas, 1/3 cup melted butter, 3/4 cup sugar, 1 egg, 1 tsp vanilla, 1 tsp baking soda, pinch of salt, 1.5 cups flour. 350F for 50 min.',
    folderId: 'recipes',
    updatedAt: '2026-05-20',
  },
  {
    id: 'lisbon',
    title: 'Lisbon trip',
    body: 'Stay in Alfama.\nTram 28 early to beat the crowds.\nPastéis de Belém is worth the line.\nDay trip to Sintra.',
    folderId: 'travel',
    updatedAt: '2026-05-15',
  },
  {
    id: 'book-notes',
    title: 'Book notes',
    body: 'Highlight from chapter 3: the best time to start was yesterday, the second best is now.',
    folderId: null,
    updatedAt: '2026-06-05',
  },
  {
    id: 'workout-split',
    title: 'Workout split',
    body: 'Mon: push.\nTue: pull.\nThu: legs.\nSat: full body or a long walk.',
    folderId: null,
    updatedAt: '2026-06-03',
  },
  {
    id: 'movie-watchlist',
    title: 'Watchlist',
    body: 'Dune Part Two\nThe Holdovers\nPast Lives\nAnatomy of a Fall',
    folderId: null,
    updatedAt: '2026-06-02',
  },
  {
    id: 'house-plants',
    title: 'Plant care',
    body: 'Monstera: water weekly.\nSnake plant: every 2-3 weeks.\nBasil: keep the soil damp, lots of sun.',
    folderId: null,
    updatedAt: '2026-06-01',
  },
  {
    id: 'passwords-todo',
    title: 'Set up password manager',
    body: 'Pick a manager, import logins from the browser, turn on 2FA for the important accounts.',
    folderId: null,
    updatedAt: '2026-05-31',
  },
  {
    id: 'birthday-plan',
    title: 'Birthday plan',
    body: 'Book the restaurant for 8.\nOrder the cake by Thursday.\nDig out the string lights.',
    folderId: null,
    updatedAt: '2026-05-29',
  },
  {
    id: 'car-maintenance',
    title: 'Car maintenance',
    body: 'Oil change due at 60k.\nRotate tires.\nCheck wiper blades before the rainy season.',
    folderId: null,
    updatedAt: '2026-05-27',
  },
  {
    id: 'side-project',
    title: 'Side project ideas',
    body: 'A tiny habit tracker.\nA CLI for renaming photos by date.\nA recipe scaler.',
    folderId: null,
    updatedAt: '2026-05-25',
  },
  {
    id: 'garden',
    title: 'Garden to-do',
    body: 'Plant tomatoes after the last frost.\nMulch the beds.\nFix the leaky hose connector.',
    folderId: null,
    updatedAt: '2026-05-24',
  },
  {
    id: 'meeting-followup',
    title: 'Meeting follow-up',
    body: 'Send the recap email.\nShare the slides.\nSchedule a check-in for next week.',
    folderId: null,
    updatedAt: '2026-05-22',
  },
  {
    id: 'reading-list',
    title: 'Reading list',
    body: 'The Pragmatic Programmer (re-read)\nA Philosophy of Software Design\nThinking in Systems',
    folderId: null,
    updatedAt: '2026-05-21',
  },
  {
    id: 'apartment-fixes',
    title: 'Apartment fixes',
    body: 'Tighten the cabinet hinge.\nReplace the bathroom bulb.\nDescale the kettle.',
    folderId: null,
    updatedAt: '2026-05-19',
  },
  {
    id: 'gift-wrap',
    title: 'Wrapping supplies',
    body: 'Brown paper, twine, a few gift tags, and tape that actually sticks this time.',
    folderId: null,
    updatedAt: '2026-05-18',
  },
  {
    id: 'playlist',
    title: 'Roadtrip playlist',
    body: 'Mix of upbeat stuff for the highway and something calmer for the late stretch.',
    folderId: null,
    updatedAt: '2026-05-16',
  },
];

