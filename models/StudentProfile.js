const mongoose = require('mongoose');

const isoDateRegex = /^\d{4}-\d{2}-\d{2}$/;

const studentProfileSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },

  // personal
  name: { type: String, required: true, trim: true },
  email: { type: String, trim: true, lowercase: true },
  altPhone: { type: String, trim: true },

  gender: { type: String, enum: ['Male', 'Female', 'Other', ''], default: '' },
  genderOther: { type: String, trim: true },

  // address
  addressLine1: { type: String, trim: true },
  addressLine2: { type: String, trim: true },
  city: { type: String, trim: true },
  state: { type: String, trim: true },
  pincode: { type: String, trim: true },

  // academic
  track: { type: String, enum: ['school', 'college', 'competitive', ''], default: '' },

  // school
  board: { type: String, trim: true },
  boardOther: { type: String, trim: true },
  classLevel: { type: String, trim: true },
  classLevelOther: { type: String, trim: true },
  stream: { type: String, trim: true },
  streamOther: { type: String, trim: true },

  // college
  program: { type: String, trim: true },
  programOther: { type: String, trim: true },
  discipline: { type: String, trim: true },
  disciplineOther: { type: String, trim: true },
  yearSem: { type: String, trim: true },
  yearSemOther: { type: String, trim: true },

  // competitive
  exam: { type: String, trim: true },
  examOther: { type: String, trim: true },
  targetYear: { type: String, trim: true },
  targetYearOther: { type: String, trim: true },

  // subjects
  subjects: [{ type: String }],
  subjectOther: { type: String, trim: true },

  // tutor prefs
  tutorGenderPref: { type: String, enum: ['Male', 'Female', 'No Preference', 'Other', ''], default: 'No Preference' },
  tutorGenderOther: { type: String, trim: true },

  // availability (dates only)
  availability: {
    type: [String],
    default: [],
    validate: {
      validator: (arr) => Array.isArray(arr) && arr.every((d) => isoDateRegex.test(d)),
      message: 'availability must be an array of YYYY-MM-DD dates',
    },
  },

  // misc
  goals: { type: String, trim: true },
  photoUrl: { type: String },

}, { timestamps: true });

module.exports = mongoose.model('StudentProfile', studentProfileSchema);
