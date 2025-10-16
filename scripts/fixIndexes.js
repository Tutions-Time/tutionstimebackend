const mongoose = require('mongoose');
require('../config/database');
const User = require('../models/User');

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

        // Exit the script
        process.exit(0);
    } catch (error) {
        console.error('Error fixing indexes:', error);
        process.exit(1);
    }
}

fixIndexes();