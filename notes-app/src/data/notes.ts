/**
 * Dummy data for the notes app. Notes either live inside a folder
 * (`folderId` set) or directly on the home screen (`folderId: null`).
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

export const folders: Folder[] = [
  { id: 'work', name: 'Work' },
  { id: 'personal', name: 'Personal' },
  { id: 'recipes', name: 'Recipes' },
  { id: 'travel', name: 'Travel' },
];

export const notes: Note[] = [
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
];

export function getFolder(id: string): Folder | undefined {
  return folders.find((folder) => folder.id === id);
}

export function getNote(id: string): Note | undefined {
  return notes.find((note) => note.id === id);
}

export function getNotesInFolder(folderId: string): Note[] {
  return notes.filter((note) => note.folderId === folderId);
}

/** Notes shown directly on the home screen (not inside a folder). */
export function getRootNotes(): Note[] {
  return notes.filter((note) => note.folderId === null);
}
