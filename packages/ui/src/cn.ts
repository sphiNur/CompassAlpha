import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * tailwind-merge only knows Tailwind's stock scales. Without being told
 * about the design tokens it reads `text-body` as a text COLOUR and drops
 * it when a real colour follows (`text-body text-secondary`), and it
 * cannot tell that `p-lg` and `p-xl` conflict.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [
        { text: ['display', 'h1', 'h2', 'body', 'label', 'small', 'caption', 'money', 'money-lg'] },
        // The old components' sizes too. Left out, `text-old-label` was read
        // as a colour and silently removed the real colour before it: a
        // primary button lost its text colour and showed dark on dark.
        {
          text: [
            'old-display',
            'old-h1',
            'old-h2',
            'old-h3',
            'old-body',
            'old-body-sm',
            'old-label',
            'old-meta',
            'old-tiny',
          ],
        },
      ],
    },
    theme: {
      spacing: [
        'xs',
        'sm',
        'md',
        'lg',
        'page',
        'xl',
        'xxl',
        'xxxl',
        'disc',
        'round',
        'chip',
        'pillbtn',
        'tap',
        'avatar',
        'control',
        'row',
      ],
      borderRadius: ['pill'],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
