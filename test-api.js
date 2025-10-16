const axios = require('axios');

const API_URL = 'http://localhost:5000/api';
let requestId, accessToken, userId;

// Test configuration
const testPhone = '9876543210';
const testOtp = '123456'; // Mock OTP for testing

// Helper function to log test results
const logTest = (name, success, data = null, error = null) => {
  console.log(`\n----- ${name} -----`);
  console.log(`Status: ${success ? 'SUCCESS ✅' : 'FAILED ❌'}`);
  if (data) console.log('Response:', JSON.stringify(data, null, 2));
  if (error) console.log('Error:', error.message || error);
};

// Run tests sequentially
const runTests = async () => {
  try {
    // 1. Test Authentication
    console.log('\n===== AUTHENTICATION TESTS =====');
    
    // 1.1 Send OTP for signup
    try {
      console.log('\nSending OTP for signup...');
      const sendOtpResponse = await axios.post(`${API_URL}/auth/send-otp`, {
        phone: testPhone,
        purpose: 'signup'
      });
      
      requestId = sendOtpResponse.data.requestId;
      logTest('Send OTP', true, sendOtpResponse.data);
    } catch (error) {
      logTest('Send OTP', false, null, error);
      console.error('AUTH TEST ERROR - Cannot continue tests without authentication');
      return;
    }
    
    // 1.2 Verify OTP
    try {
      console.log('\nVerifying OTP...');
      const verifyOtpResponse = await axios.post(`${API_URL}/auth/verify-otp`, {
        phone: testPhone,
        otp: testOtp,
        requestId,
        role: 'student'
      });
      
      accessToken = verifyOtpResponse.data.tokens.accessToken;
      userId = verifyOtpResponse.data.user.id;
      logTest('Verify OTP', true, verifyOtpResponse.data);
    } catch (error) {
      logTest('Verify OTP', false, null, error);
      console.error('AUTH TEST ERROR - Cannot continue tests without authentication');
      return;
    }
    
    // 2. Test Student Profile CRUD
    console.log('\n===== STUDENT PROFILE TESTS =====');
    
    // 2.1 Create/Update Student Profile
    try {
      console.log('\nUpdating student profile...');
      const updateProfileResponse = await axios.post(`${API_URL}/users/student/profile`, {
        name: 'Test Student',
        email: 'student@test.com',
        gender: 'male',
        classLevel: 'Class 10',
        subjects: ['Mathematics', 'Science'],
        goals: 'Improve grades',
        pincode: '110001'
      }, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      
      logTest('Update Student Profile', true, updateProfileResponse.data);
    } catch (error) {
      logTest('Update Student Profile', false, null, error);
    }
    
    // 2.2 Get Student Profile
    try {
      console.log('\nGetting user profile...');
      const getProfileResponse = await axios.get(`${API_URL}/users/profile`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      
      logTest('Get User Profile', true, getProfileResponse.data);
    } catch (error) {
      logTest('Get User Profile', false, null, error);
    }
    
    // 3. Test Admin Operations (should fail with student token)
    console.log('\n===== ADMIN OPERATIONS TESTS =====');
    
    try {
      console.log('\nAttempting to access admin endpoint (should fail)...');
      await axios.get(`${API_URL}/admin/users`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      
      logTest('Admin Access Test', false, { message: 'This should have failed but succeeded' });
    } catch (error) {
      // This should fail, so it's actually a success
      logTest('Admin Access Test', true, { message: 'Correctly denied access to admin endpoint' });
    }
    
    // 4. Test Subject API
    console.log('\n===== SUBJECT API TESTS =====');
    
    // Create a test subject
    try {
      console.log('\nCreating a test subject...');
      const createSubjectResponse = await axios.post(`${API_URL}/subjects`, {
        name: 'Test Subject',
        active: true
      }, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      
      logTest('Create Subject', true, createSubjectResponse.data);
    } catch (error) {
      logTest('Create Subject', false, null, error);
    }
    
    // Get all subjects
    try {
      console.log('\nGetting all subjects...');
      const getSubjectsResponse = await axios.get(`${API_URL}/subjects`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      
      logTest('Get Subjects', true, getSubjectsResponse.data);
    } catch (error) {
      logTest('Get Subjects', false, null, error);
    }
    
    console.log('\n===== ALL TESTS COMPLETED =====');
    
  } catch (error) {
    console.error('Test execution error:', error.message);
  }
};

// Run the tests
runTests();