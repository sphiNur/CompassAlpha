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
        { text: ['display', 'h1', 'h2', 'body', 'label', 'caption', 'money', 'money-lg'] },
        // apps/web's older scale (tailwind.config.js). Unregistered, a size
        // followed by a colour lost the size, and a size after `text-white`
        // dropped the white from every primary button.
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
      spacing: ['xs', 'sm', 'md', 'lg', 'page', 'xl', 'xxl', 'xxxl', 'tap', 'control', 'row'],
      borderRadius: ['pill'],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
