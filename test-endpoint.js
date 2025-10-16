const axios = require('axios');

// Test the basic endpoint
const testBasicEndpoint = async () => {
  try {
    console.log('\n===== Testing Basic Endpoint =====');
    const response = await axios.get('http://localhost:5000/api/test');
    console.log('Status:', response.status);
    console.log('Response:', JSON.stringify(response.data, null, 2));
    return true;
  } catch (error) {
    console.error('Error:', error.message);
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Response:', JSON.stringify(error.response.data, null, 2));
    }
    return false;
  }
};

// Run test
testBasicEndpoint().then(success => {
  console.log('\nTest completed. Success:', success);
});