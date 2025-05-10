# Research Assistant Backend

A robust Node.js backend for the Research Assistant application, providing paper management, analysis, and collaboration features.

## 🚀 Features

- 📚 Paper Storage & Management
- 🔍 Full-text Search
- 📊 Paper Analysis
- 🔐 Authentication & Authorization
- 📝 Paper Summaries Generation
- 🏷️ Tagging System
- 📈 Activity Tracking

## 🛠️ Tech Stack

- Node.js & Express.js
- MongoDB with Mongoose
- JWT Authentication
- Gemini Integration
- PDF Processing
- WebSocket for Real-time Features

## 📋 Prerequisites

Before you begin, ensure you have the following installed:
- Node.js (v14.0.0 or higher)
- npm (v6.0.0 or higher)
- MongoDB (v4.4 or higher)
- Git

## 🔧 Installation & Setup

1. **Clone the repository**
   ```powershell
   git clone <repository-url>
   cd research-assistant/backend
   ```

2. **Install dependencies**
   ```powershell
   npm install
   ```

3. **Environment Setup**
   - Make the `.env` from `env.txt` file
   - Update the environment variables in `.env` with your configuration

4. **Start MongoDB**
   - Ensure MongoDB is running on your system
   - Create a new database for the project

5. **Start the server**
   ```powershell
   # Development
   npm run dev
   
   # Production
   npm start
   ```

The server will start on `http://localhost:8000` by default.

## 🌐 Environment Variables

Create a `.env` file in the backend root directory. See `.env.example` for the required variables:
```plaintext
# Server Configuration
PORT=5000
NODE_ENV=development

# MongoDB Configuration
MONGODB_URI=mongodb://localhost:27017/research_assistant

# JWT Configuration
JWT_SECRET=your-secret-key
JWT_EXPIRE=7d

# OpenAI Configuration
OPENAI_API_KEY=your-openai-api-key

# File Upload Configuration
MAX_FILE_SIZE=10000000
UPLOAD_PATH=./uploads

# CORS Configuration
ALLOWED_ORIGINS=http://localhost:3000
```

## 📁 Project Structure

```
src/
├── config/          # Configuration files
├── controllers/     # Request handlers
├── middleware/      # Custom middleware
├── models/         # Mongoose models
├── routes/         # API routes
├── services/       # Business logic
├── utils/          # Utility functions
└── app.js          # App entry point
```

## 📝 API Documentation

### Authentication
- POST `/api/auth/register` - Register new user
- POST `/api/auth/login` - Login user
- GET `/api/auth/me` - Get current user

### Papers
- GET `/api/papers` - Get all papers
- POST `/api/papers` - Upload new paper
- GET `/api/papers/:id` - Get paper by ID
- PUT `/api/papers/:id` - Update paper
- DELETE `/api/papers/:id` - Delete paper

### Lists
- GET `/api/lists` - Get all reading lists
- POST `/api/lists` - Create new list
- PUT `/api/lists/:id` - Update list
- DELETE `/api/lists/:id` - Delete list

### Tags
- GET `/api/tags` - Get all tags
- POST `/api/tags` - Create new tag
- DELETE `/api/tags/:id` - Delete tag

## 🔨 Available Scripts

- `npm start` - Start production server
- `npm run dev` - Start development server
- `npm test` - Run tests
- `npm run lint` - Run ESLint

## 🧪 Testing

```powershell
# Run all tests
npm test

# Run specific test file
npm test -- tests/auth.test.js
```

## 🔒 Security Features

- JWT Authentication
- Password Hashing
- Rate Limiting
- CORS Protection
- XSS Prevention
- Request Validation

## 💾 Database

MongoDB is used as the primary database. The schema can be found in the `models` directory.

## 🤝 Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request
