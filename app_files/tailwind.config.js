/** @type {import('tailwindcss').Config} */
module.exports = {
	darkMode: ["class"],
	content: [
		"./pages/**/*.{ts,tsx}",
		"./components/**/*.{ts,tsx}",
		"./app/**/*.{ts,tsx}",
		"./src/**/*.{ts,tsx}",
	],
	prefix: "",
	theme: {
		container: {
			center: true,
			padding: '2rem',
			screens: {
				'2xl': '1400px'
			}
		},
		extend: {
			// Type system: faces are set by --font-display / --font-body in src/index.css.
			// Headings: font-display. Body text: font-sans (the default).
			fontFamily: {
				display: ['var(--font-display)', 'Chivo', 'sans-serif'],
				sans: ['var(--font-body)', 'Source Sans 3', 'sans-serif'],
				body: ['var(--font-body)', 'Source Sans 3', 'sans-serif']
			},
			// borderColor must be explicitly set for @apply border-border to work
			borderColor: {
				DEFAULT: 'hsl(var(--border))',
			},
			colors: {
				border: 'hsl(var(--border))',
				input: 'hsl(var(--input))',
				ring: 'hsl(var(--ring))',
				background: 'hsl(var(--background))',
				foreground: 'hsl(var(--foreground))',
				primary: {
					DEFAULT: 'hsl(var(--primary))',
					foreground: 'hsl(var(--primary-foreground))'
				},
				secondary: {
					DEFAULT: 'hsl(var(--secondary))',
					foreground: 'hsl(var(--secondary-foreground))'
				},
				destructive: {
					DEFAULT: 'hsl(var(--destructive))',
					foreground: 'hsl(var(--destructive-foreground))'
				},
				muted: {
					DEFAULT: 'hsl(var(--muted))',
					foreground: 'hsl(var(--muted-foreground))'
				},
				accent: {
					DEFAULT: 'hsl(var(--accent))',
					foreground: 'hsl(var(--accent-foreground))'
				},
				popover: {
					DEFAULT: 'hsl(var(--popover))',
					foreground: 'hsl(var(--popover-foreground))'
				},
				card: {
					DEFAULT: 'hsl(var(--card))',
					foreground: 'hsl(var(--card-foreground))'
				},
				sidebar: {
					DEFAULT: 'hsl(var(--sidebar-background))',
					foreground: 'hsl(var(--sidebar-foreground))',
					primary: 'hsl(var(--sidebar-primary))',
					'primary-foreground': 'hsl(var(--sidebar-primary-foreground))',
					accent: 'hsl(var(--sidebar-accent))',
					'accent-foreground': 'hsl(var(--sidebar-accent-foreground))',
					border: 'hsl(var(--sidebar-border))',
					ring: 'hsl(var(--sidebar-ring))'
				},
				task: {
					complete: 'hsl(var(--task-complete))',
					pending: 'hsl(var(--task-pending))',
					high: 'hsl(var(--task-high))'
				}
			},
			borderRadius: {
				lg: 'var(--radius)',
				md: 'calc(var(--radius) - 2px)',
				sm: 'calc(var(--radius) - 4px)',
				// xl/2xl/3xl also derive from --radius so the Theme Editor's Radius
				// control scales the WHOLE rounded-* range — AI-generated components
				// lean on rounded-xl/2xl heavily. At the default --radius (0.5rem)
				// these equal Tailwind's built-in xl/2xl/3xl (12/16/24px), so this is
				// non-destructive for default-radius apps. (Existing apps keep their
				// frozen config; they get the same behavior via the unlayered
				// radius-normalization block AppTheme#generate_css_content re-emits
				// into src/index.css on every theme save.)
				xl: 'calc(var(--radius) + 4px)',
				'2xl': 'calc(var(--radius) + 8px)',
				'3xl': 'calc(var(--radius) + 16px)'
			},
			keyframes: {
				'accordion-down': {
					from: {
						height: '0'
					},
					to: {
						height: 'var(--radix-accordion-content-height)'
					}
				},
				'accordion-up': {
					from: {
						height: 'var(--radix-accordion-content-height)'
					},
					to: {
						height: '0'
					}
				}
			},
			animation: {
				'accordion-down': 'accordion-down 0.2s ease-out',
				'accordion-up': 'accordion-up 0.2s ease-out'
			},
			// Add commonly misused shadow utilities that AI might generate
			boxShadow: {
				'3xl': '0 35px 60px -15px rgba(0, 0, 0, 0.3)',
				'4xl': '0 45px 80px -20px rgba(0, 0, 0, 0.35)',
				'5xl': '0 55px 100px -25px rgba(0, 0, 0, 0.4)'
			}
		}
	},
	plugins: [require("tailwindcss-animate")],
};