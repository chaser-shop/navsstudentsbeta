import mongoose from 'mongoose';
// Перевірте правильний шлях до вашої моделі User
import User from '../models/User.js';

const uri = process.env.MONGODB_URI;
const fullName = process.argv.slice(2).join(' ').trim();

if (!uri) {
  console.error('❌ Помилка: не вказано MONGODB_URI');
  process.exit(1);
}

if (!fullName) {
  console.error('❌ Помилка: вкажіть ПІБ. Приклад: npm run make-admin "Іванов Іван Іванович"');
  process.exit(1);
}

async function run() {
  try {
    await mongoose.connect(uri);

    // Знаходимо за ПІБ або створюємо нового (замініть fullName на назву поля у вашій схемі, якщо вона інша)
    const user = await User.findOneAndUpdate(
      { fullName: fullName },
      { $set: { isAdmin: true } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    console.log(`✅ Готово! Користувач "${user.fullName}" тепер має права адміністратора (isAdmin: true).`);
  } catch (err) {
    console.error('❌ Помилка при роботі з базою:', err);
  } finally {
    await mongoose.disconnect();
  }
}

run();
