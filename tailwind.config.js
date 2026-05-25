/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      colors: {
        ssi: {
          brand: '#0a66c2',
          ink: '#0b1419',
          mute: '#5e6d77',
        },
      },
    },
  },
  plugins: [],
};
