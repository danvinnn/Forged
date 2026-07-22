# Gemini AI Integration Setup

To enable AI-powered datasheet search and parsing, set up a Google Gemini API key:

## Getting Your Gemini API Key

1. Go to [Google AI Studio](https://aistudio.google.com/app/apikey)
2. Click "Create API Key" (you may need a Google account)
3. Copy the generated API key

## Environment Configuration

Create a `.env.local` file in the project root:

```env
GOOGLE_GEMINI_API_KEY=your-api-key-here
```

## How It Works

When the API key is configured:

- **Datasheet Lookup** (`/api/lookup`) uses Gemini to intelligently find datasheet PDFs
- **Datasheet Parsing** (`/api/parse`) uses Gemini's understanding to extract structured data from PDFs
- Falls back to regex-based search/parsing if the key is not set

## Without Gemini

If the `GOOGLE_GEMINI_API_KEY` is not set:
- Lookup uses DuckDuckGo web search (slower, less reliable)
- Parsing uses regex patterns (prone to extraction errors)

## Testing

After configuring the API key, rebuild and restart:

```bash
npm run build
npm run start
```

Then test the endpoints with a part number:

```bash
curl -X POST http://localhost:3000/api/lookup \
  -H "Content-Type: application/json" \
  -d '{"partNumber": "INA240A1", "manufacturer": "Texas Instruments"}'
```
