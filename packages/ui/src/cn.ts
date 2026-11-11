import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * tailwind-merge only knows Tailwind's stock scales. Told nothing about
 * the type scale (../tailwind.preset.js) it reads `text-old-body` as a
 * text COLOUR: a size followed by a colour lost the size, and a size
 * after `text-white` dropped the white from every primary button.
 * typeScale.test.ts checks that this list names every size there.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [
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
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
