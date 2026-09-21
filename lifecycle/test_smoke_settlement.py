"""Native35595738434 reproducer: exited handles retain times but image query fails31."""
import copy
import unittest
from unittest.mock import patch
import run

class Child:
    pid=8076
    _handle=object()  # retained handle; native call is mocked, never a PID reopen
    code=0
    def poll(self):return self.code

class Settlement(unittest.TestCase):
    def setUp(self):
        self.start={'pid':8076,'created100ns':'134344647270521505','exited100ns':'0',
                    'executable':r'D:\fixture\python.exe','nativeMachine':34404,'processMachine':0}
        self.end={'pid':8076,'created100ns':'134344647270521505','exited100ns':'134344647421287073',
                  'executableError':{'api':'QueryFullProcessImageNameW','winerror':31},
                  'nativeMachine':34404,'processMachine':0}
    def finish(self, end=None, code=0):
        s=object.__new__(run.Session);s.api=None;s.deadline=0
        c=Child();c.code=code
        record={'identity':self.start};s.children=[(c,record)]
        raw=copy.deepcopy(self.end if end is None else end)
        with patch.object(run,'process_identity',return_value=raw) as identity:
            settled=s.finish()
            identity.assert_called_once_with(None,c.pid,c._handle)
        self.assertEqual(record['terminalIdentity'],raw)
        return settled,record
    def test_actual_error31_after_exit_is_bound_to_held_handle(self):
        settled,record=self.finish()
        self.assertTrue(settled)
        self.assertNotIn('executable',record['terminalIdentity'])
    def test_normal_terminal_image_query(self):
        e=dict(self.end,executable=self.start['executable']);e.pop('executableError')
        self.assertTrue(self.finish(e)[0])
    def test_pid_reuse_or_creation_mismatch(self):
        for change in ({'pid':8077},{'created100ns':'134344647270521506'}):
            with self.subTest(change=change):self.assertFalse(self.finish(dict(self.end,**change))[0])
    def test_no_terminal_time_or_unsettled_child(self):
        for change in ({'exited100ns':'0'},{'exited100ns':'bad'},{'exited100ns':self.start['created100ns']}):
            with self.subTest(change=change):self.assertFalse(self.finish(dict(self.end,**change))[0])
        self.assertFalse(self.finish(code=None)[0])
    def test_other_errors_or_missing_image_evidence_rejected(self):
        for error in ({'api':'QueryFullProcessImageNameW','winerror':5},{'api':'wrong','winerror':31},None):
            with self.subTest(error=error):self.assertFalse(self.finish(dict(self.end,executableError=error))[0])
    def test_changed_executable_or_architecture_rejected(self):
        for change in ({'executable':r'D:\other.exe'},{'nativeMachine':0xaa64},{'processMachine':0x14c}):
            with self.subTest(change=change):self.assertFalse(self.finish(dict(self.end,**change))[0])

if __name__=='__main__':unittest.main()
