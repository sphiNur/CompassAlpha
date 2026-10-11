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
