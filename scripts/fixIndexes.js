const mongoose = require('mongoose');
const connectDB = require('../config/database');
connectDB();
const User = require('../models/User');
const Note = require('../models/Note');

async function fixIndexes() {
    try {
        // console.log('Getting current indexes...');
        const indexes = await User.collection.getIndexes();
        // console.log('Current indexes:', indexes);

        // Drop the problematic mobileNumber index if it exists
        console.log('Dropping mobileNumber index...');
        try {
            await User.collection.dropIndex('mobileNumber_1');
            console.log('Successfully dropped mobileNumber index');
        } catch (err) {
            if (err.code === 27) {
                console.log('mobileNumber index does not exist, skipping...');
            } else {
                throw err;
            }
        }

        // Ensure the phone index exists
        console.log('Creating/updating phone index...');
        await User.collection.createIndex({ phone: 1 }, { unique: true });
        console.log('Successfully created phone index');

        // console.log('Final indexes:');
        console.log(await User.collection.getIndexes());

        // ===== Notes index fix =====
        console.log('Checking Note indexes...');
        const noteIndexes = await Note.collection.getIndexes();
        for (const [name] of Object.entries(noteIndexes)) {
            if (name.includes('keywords_text') || name.includes('keywords_1')) {
                console.log(`Dropping outdated Note index: ${name}`);
                try {
                    await Note.collection.dropIndex(name);
                    console.log(`Dropped index ${name}`);
                } catch (err) {
                    if (err.code === 27) {
                        console.log(`Index ${name} not found, skipping...`);
                    } else {
                        throw err;
                    }
                }
            }
        }

        console.log('Ensuring Note indexes...');
        await Note.collection.createIndex({ title: 'text', description: 'text' });
        await Note.collection.createIndex({ subject: 1, classLevel: 1, board: 1 });
        console.log('Final Note indexes:', await Note.collection.getIndexes());

        // Exit the script
        process.exit(0);
    } catch (error) {
        console.error('Error fixing indexes:', error);
        process.exit(1);
    }
}

fixIndexes();
