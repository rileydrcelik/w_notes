/**
 * Seed data for the copa (copy/paste) feed. Each item is a labelled snippet
 * whose contents can be copied to the clipboard with a single tap.
 *
 * These are only the initial defaults: at runtime the live, editable copy lives
 * in the copa store (`@/store/copa-store`), which seeds itself from here.
 */

export type CopaItem = {
  id: string;
  label: string;
  content: string;
  favorite?: boolean;
};

export const seedCopaItems: CopaItem[] = [
  { id: '1', label: 'Email', content: 'stevebaconpants@gmail.com' },
  { id: '2', label: 'Phone', content: '+1 (555) 014-2733' },
  { id: '3', label: 'Address', content: '1600 Amphitheatre Parkway, Mountain View, CA 94043' },
  { id: '4', label: 'Wi-Fi password', content: 'correct-horse-battery-staple' },
  { id: '5', label: 'Meeting link', content: 'https://meet.example.com/copa-standup-9a4f' },
  { id: '6', label: 'API key', content: 'sk-live-7c2b9f04e1a84d6db0f3c5a1e2840bb9' },
  {
    id: '7',
    label: 'Snippet',
    content: 'Thanks for reaching out — I will get back to you within one business day.',
  },
  {
    id: '8',
    label: 'Lorem',
    content:
      'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
  },
  {
    id: '9',
    label: 'Cover letter',
    content:
      'Dear Hiring Manager, I am writing to express my strong interest in the position. Over the past several years I have built and shipped products end to end, collaborated closely with design and engineering teams, and consistently delivered work that I am proud of. I would welcome the opportunity to bring that same energy and attention to detail to your team, and I am confident that my background makes me a great fit for what you are looking for. Thank you for your time and consideration — I look forward to hearing from you and discussing how I can contribute.',
  },
  {
    id: '10',
    label: 'Long lorem',
    content:
      'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum. Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium.',
  },
  {
    id: '11',
    label: 'Terms blurb',
    content:
      'By using this service you agree to the following terms and conditions, which govern your access to and use of the application, including all content, functionality, and services offered. These terms apply to all visitors, users, and others who access or use the service. Please read them carefully before proceeding, as your continued use constitutes acceptance of every provision, limitation, and obligation described herein, as well as any future amendments that may be published from time to time without prior individual notice.',
  },
];
